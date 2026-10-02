#!/usr/bin/env bash
# Протокол v2 (spec 007, T064): C++-тест v2-сессии parvane-core против живого
# изолированного стека — nats + identity + messenger + gateway на свободных
# портах (не мешает другим стекам на 4222/9222/9223), временные БД.
# Нужны: nats-server в PATH (или ~/.local/bin), собранные шарды
# backend/target/debug/{identity,messenger,gateway} и тест
# parvane-core/build/parvane_v2_session_tests.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../verify_paths.sh"
TEST_BIN="${PARVANE_V2_TEST_BIN:-$HERE/../build/parvane_v2_session_tests}"
export PATH="$HOME/.local/bin:$PATH"
command -v nats-server >/dev/null || { echo "нет nats-server"; exit 2; }
[ -x "$TEST_BIN" ] || { echo "нет $TEST_BIN — cmake --build parvane-core/build --target parvane_v2_session_tests"; exit 2; }
for s in identity messenger gateway; do
  [ -x "$SHARD/$s" ] || { echo "нет шарда $SHARD/$s — cargo build -p $s"; exit 2; }
done
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
NP=$(free_port); TP=$(free_port); WP=$(free_port)
SB="$(mktemp -d /tmp/parvane-v2-live-XXXXXX)"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT
nats-server -a 127.0.0.1 -p "$NP" >"$SB/nats.log" 2>&1 & PIDS+=($!)
sleep 0.5
NATS="nats://127.0.0.1:$NP"
env PARVANE_LOGIN_RATE=100000 PARVANE_LOGIN_RATE_IP=100000 PARVANE_REGISTER_RATE=100000 \
  PARVANE_REGISTER_RATE_IP=100000 PARVANE_REGISTER_RATE_GLOBAL=100000 PARVANE_DEV=1 \
  PARVANE_NATS_URL="$NATS" PARVANE_DB_PATH="$SB/identity.db" PARVANE_WELL_KNOWN_FILE="$SB/parvane.json" \
  PARVANE_LOG_LEVEL=info "$SHARD/identity" >"$SB/identity.log" 2>&1 & PIDS+=($!)
PARVANE_NATS_URL="$NATS" PARVANE_DB_PATH="$SB/messenger.db" PARVANE_LOG_LEVEL=info \
  "$SHARD/messenger" >"$SB/messenger.log" 2>&1 & PIDS+=($!)
PARVANE_NATS_URL="$NATS" PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$TP" PARVANE_GATEWAY_BIND="127.0.0.1:$WP" \
  PARVANE_V2_FEATURES=sealed PARVANE_LOG_LEVEL=info "$SHARD/gateway" >"$SB/gateway.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do
  grep -q "NATS подключён" "$SB/identity.log" 2>/dev/null && grep -q "NATS подключён" "$SB/messenger.log" 2>/dev/null \
    && (exec 3<>"/dev/tcp/127.0.0.1/$TP") 2>/dev/null && break
  sleep 0.5
done
sleep 1
PARVANE_GATEWAY_TCP="127.0.0.1:$TP" PARVANE_V2_WS_URL="ws://127.0.0.1:$WP/ws" "$TEST_BIN"
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "--- хвосты логов стека ($SB) ---"
  for f in identity messenger gateway; do echo "## $f"; tail -15 "$SB/$f.log"; done
else
  rm -rf "$SB"
fi
exit "$RC"
