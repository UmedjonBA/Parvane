#!/usr/bin/env bash
# Персистентное web-демо: постоянные серверные БД и профили браузера в
# local-workdirs/demos/parvane-web-demo. Переписка двух аккаунтов alice/bob
# переживает перезапуск. Останов — Ctrl-C (БД и профили НЕ удаляются).

set -Eeuo pipefail
# Хуки window.__parvane* для пробников — только в e2e/demo-сборках
export VITE_PARVANE_DIAG_HOOKS=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ROOT="$ROOT/web/telegram-tt"
DEMO_ROOT="$ROOT/local-workdirs/demos/parvane-web-demo"
DB_DIR="$DEMO_ROOT/db"
LOG_DIR="$DEMO_ROOT/logs"
PROFILES_DIR="$DEMO_ROOT/profiles"
mkdir -p "$DB_DIR" "$LOG_DIR" "$PROFILES_DIR"
PIDS=()

# Фиксированные порты (стабильный gateway URL для сохранённых профилей)
NATS_PORT=14222
GATEWAY_WS_PORT=19222
GATEWAY_TCP_PORT=19223
WEB_PORT=18080

# Фиксированные пароли шин (persist не требует секретности — это локальное демо)
export PARVANE_IDENTITY_PASS=demo-identity
export PARVANE_MESSENGER_PASS=demo-messenger
export PARVANE_CLOUD_PASS=demo-cloud
export PARVANE_NOTES_PASS=demo-notes
export PARVANE_CALENDAR_PASS=demo-calendar
export PARVANE_CALL_PASS=demo-call
export PARVANE_PREVIEW_PASS=demo-preview
export PARVANE_PUSH_PASS=demo-push
export PARVANE_GATEWAY_PASS=demo-gateway

log() { printf '\n== %s ==\n' "$*"; }

cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  printf '\nДемо остановлено. БД и профили сохранены в %s\n' "$DEMO_ROOT"
}
trap cleanup EXIT INT TERM

wait_for_log() {
  local name="$1"
  local pattern="$2"
  local pid="$3"
  local file="$LOG_DIR/$name.log"
  for _ in {1..300}; do
    rg -q "$pattern" "$file" 2>/dev/null && return
    kill -0 "$pid" 2>/dev/null || { echo "$name упал:"; tail -40 "$file"; return 1; }
    sleep 0.1
  done
  echo "$name: таймаут"; tail -40 "$file"; return 1
}

start_shard() {
  local shard="$1"
  local pass="$2"
  env PARVANE_NATS_URL="nats://127.0.0.1:$NATS_PORT" \
      PARVANE_NATS_USER="$shard" PARVANE_NATS_PASS="$pass" \
      PARVANE_DB_PATH="$DB_DIR/$shard.db" PARVANE_LOG_LEVEL=info \
      "$ROOT/target/debug/$shard" >"$LOG_DIR/$shard.log" 2>&1 &
  PIDS+=("$!")
}

log "Build backend"
cd "$ROOT"
cargo build -p identity -p messenger -p cloud -p call -p preview -p push -p gateway

log "Start NATS (persistent)"
nats-server -c "$ROOT/infra/nats/server.prod.conf" -a 127.0.0.1 -p "$NATS_PORT" \
  >"$LOG_DIR/nats.log" 2>&1 &
PIDS+=("$!")
wait_for_log nats 'Server is ready' "${PIDS[-1]}"

log "Start shards (persistent DBs)"
start_shard identity "$PARVANE_IDENTITY_PASS"
start_shard messenger "$PARVANE_MESSENGER_PASS"
start_shard cloud "$PARVANE_CLOUD_PASS"
start_shard call "$PARVANE_CALL_PASS"
start_shard preview "$PARVANE_PREVIEW_PASS"
start_shard push "$PARVANE_PUSH_PASS"
wait_for_log identity 'Identity шард запущен' "${PIDS[-6]}"
wait_for_log messenger 'Messenger шард запущен' "${PIDS[-5]}"
wait_for_log cloud 'Cloud шард запущен' "${PIDS[-4]}"
wait_for_log call 'Call шард запущен' "${PIDS[-3]}"
wait_for_log preview 'Preview шард запущен' "${PIDS[-2]}"
wait_for_log push 'Push шард запущен' "${PIDS[-1]}"

log "Start gateway"
env PARVANE_NATS_URL="nats://127.0.0.1:$NATS_PORT" \
    PARVANE_NATS_USER=gateway PARVANE_NATS_PASS="$PARVANE_GATEWAY_PASS" \
    PARVANE_GATEWAY_BIND="127.0.0.1:$GATEWAY_WS_PORT" \
    PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$GATEWAY_TCP_PORT" \
    PARVANE_LOG_LEVEL=info \
    "$ROOT/target/debug/gateway" >"$LOG_DIR/gateway.log" 2>&1 &
PIDS+=("$!")
wait_for_log gateway 'Gateway WebSocket' "${PIDS[-1]}"

log "Build and start web"
cd "$WEB_ROOT"
if [[ "${PARVANE_DEMO_SKIP_WEB_BUILD:-0}" != "1" ]]; then
  npm run build:production
fi
node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
  >"$LOG_DIR/web.log" 2>&1 &
PIDS+=("$!")
wait_for_log web "http://127.0.0.1:$WEB_PORT" "${PIDS[-1]}"

log "Launch two persistent clients"
cd "$ROOT"
PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" \
PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:$GATEWAY_WS_PORT" \
PARVANE_DEMO_PROFILES="$PROFILES_DIR" \
node "$ROOT/scripts/demo_persistent_clients.mjs"
