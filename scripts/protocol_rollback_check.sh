#!/usr/bin/env bash
# Проверка отката сервера E1 → v1 (spec 007, T038, FR-056).
#
#  1. собирает шарды E1 (текущее дерево) и v1 (коммит V1_REF, по умолчанию
#     595d3308 — последний v1 до протокола v2) в отдельный target;
#  2. поднимает nats + E1 identity/messenger/gateway на временных БД, пишет
#     v1-переписку (метка e1), делает v2-рукопожатие;
#  3. останавливает E1, поднимает v1-бинарники НА ТЕХ ЖЕ БД: v1-клиент видит
#     всю историю и пишет новое сообщение (метка v1);
#  4. возвращает E1: история (e1 + v1) цела, v2-базы шардов (`*-v2.db`, если
#     есть) не изменились за время отката.
#
# Тяжёлая часть — одна debug-сборка v1 (identity, messenger, gateway) в
# local-workdirs/protocol-rollback/; повторные запуски переиспользуют её.
# Запуск: scripts/protocol_rollback_check.sh [--clean]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$REPO/backend"
V1_REF="${V1_REF:-595d3308}"
WORK="$REPO/local-workdirs/protocol-rollback"
V1_SRC="$WORK/v1src"
V1_TARGET="$WORK/v1target"
RUN="$(mktemp -d)"
NATS_BIN="$(command -v nats-server || echo "$HOME/.local/bin/nats-server")"
PIDS=()
FAIL=0

log() { printf '\n== %s\n' "$*"; }
fail() { echo "❌ $*"; FAIL=1; }

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$RUN"
}
trap cleanup EXIT

if [[ "${1:-}" == "--clean" ]]; then
  git -C "$REPO" worktree remove --force "$V1_SRC" 2>/dev/null || true
  rm -rf "$WORK"
fi
mkdir -p "$WORK"

log "Сборка E1 (текущее дерево)"
(cd "$BACKEND" && cargo build -q -p identity -p messenger -p gateway)
E1_BIN="$BACKEND/target/debug"

log "Сборка v1 ($V1_REF)"
if [[ ! -d "$V1_SRC" ]]; then
  git -C "$REPO" worktree add --detach "$V1_SRC" "$V1_REF" >/dev/null
fi
(cd "$V1_SRC/backend" && CARGO_TARGET_DIR="$V1_TARGET" cargo build -q -p identity -p messenger -p gateway)
V1_BIN="$V1_TARGET/debug"

PORT=$((20000 + RANDOM % 20000))
export NATS_URL="nats://127.0.0.1:$PORT"
"$NATS_BIN" -a 127.0.0.1 -p "$PORT" >"$RUN/nats.log" 2>&1 & PIDS+=($!)
sleep 0.5
GW_TCP="127.0.0.1:$((PORT + 1))"
GW_WS="127.0.0.1:$((PORT + 2))"

start_shards() { # $1 — каталог бинарников, $2 — метка логов
  local bin="$1" tag="$2"
  PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$RUN/identity.db" PARVANE_DEV=1 \
    "$bin/identity" >"$RUN/identity-$tag.log" 2>&1 & SH_PIDS=($!)
  PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$RUN/messenger.db" \
    "$bin/messenger" >"$RUN/messenger-$tag.log" 2>&1 & SH_PIDS+=($!)
  PARVANE_NATS_URL="$NATS_URL" PARVANE_GATEWAY_TCP_BIND="$GW_TCP" PARVANE_GATEWAY_BIND="$GW_WS" \
    "$bin/gateway" >"$RUN/gateway-$tag.log" 2>&1 & SH_PIDS+=($!)
  for _ in $(seq 1 100); do
    if grep -q "Messenger шард запущен\|NATS подключён" "$RUN/messenger-$tag.log" 2>/dev/null \
       && grep -q "NATS подключён" "$RUN/identity-$tag.log" 2>/dev/null; then
      sleep 0.5; return 0
    fi
    sleep 0.2
  done
  fail "шарды ($tag) не стартовали"; tail -5 "$RUN"/*-"$tag".log; return 1
}
stop_shards() { for p in "${SH_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; sleep 1; }

v2_fingerprint() { (cd "$RUN" && ls ./*-v2.db 2>/dev/null | xargs -r sha256sum) || true; }

log "E1: v1-переписка и v2-рукопожатие"
start_shards "$E1_BIN" e1
python3 "$REPO/scripts/protocol_rollback_check.py" write e1 || fail "запись e1"
python3 - "$GW_TCP" <<'PY' || fail "v2-рукопожатие на E1"
import socket, sys
host, port = sys.argv[1].rsplit(":", 1)
s = socket.create_connection((host, int(port)), timeout=5)
# PVN2 + varint(len) + Frame{proto_major:2, hello{}} = 08 02 52 00
frame = bytes([0x08, 0x02, 0x52, 0x00])
s.sendall(b"PVN2" + bytes([len(frame)]) + frame)
data = s.recv(4096)
assert b"\x08\x02" in data[:5], data[:16]
print("  ✅ v2 Welcome получен")
PY
python3 "$REPO/scripts/protocol_rollback_check.py" check e1 || fail "история на E1"
BEFORE="$(v2_fingerprint)"
stop_shards

log "Откат на v1 ($V1_REF) на тех же БД"
start_shards "$V1_BIN" v1
python3 "$REPO/scripts/protocol_rollback_check.py" check e1 || fail "v1 не видит историю E1"
python3 "$REPO/scripts/protocol_rollback_check.py" write v1 || fail "запись на v1"
python3 "$REPO/scripts/protocol_rollback_check.py" check e1 v1 || fail "v1 не видит новое сообщение"
stop_shards
AFTER="$(v2_fingerprint)"
[[ "$BEFORE" == "$AFTER" ]] || fail "v2-базы изменились во время отката"

log "Возврат E1"
start_shards "$E1_BIN" e1b
python3 "$REPO/scripts/protocol_rollback_check.py" check e1 v1 || fail "E1 после возврата не видит историю"
stop_shards

if [[ "$FAIL" == 0 ]]; then
  echo; echo "РЕЗУЛЬТАТ: ✅ откат E1 → v1 → E1 без потерь"
else
  echo; echo "РЕЗУЛЬТАТ: ❌ (логи: $RUN сохраняются до выхода)"; exit 1
fi
