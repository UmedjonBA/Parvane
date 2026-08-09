#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ROOT="$ROOT/web/telegram-tt"
TEMP_ROOT="$(mktemp -d /tmp/parvane-web-e2e.XXXXXX)"
PIDS=()
ALLOCATED_PORTS=()

allocate_port() {
  local destination="$1"
  local override_name="$2"
  local candidate="${!override_name:-}"

  while [[ -z "$candidate" ]]; do
    candidate="$(node -e '
      const net = require("node:net");
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        console.log(server.address().port);
        server.close();
      });
    ')"
    if [[ " ${ALLOCATED_PORTS[*]} " == *" $candidate "* ]]; then
      candidate=""
    fi
  done

  if [[ ! "$candidate" =~ ^[0-9]+$ ]] || (( candidate < 1024 || candidate > 65535 )); then
    printf 'Invalid port from %s: %s\n' "$override_name" "$candidate" >&2
    exit 1
  fi
  if [[ " ${ALLOCATED_PORTS[*]} " == *" $candidate "* ]]; then
    printf 'Duplicate e2e port from %s: %s\n' "$override_name" "$candidate" >&2
    exit 1
  fi

  printf -v "$destination" '%s' "$candidate"
  ALLOCATED_PORTS+=("$candidate")
}

IDENTITY_PASS="parvane-e2e-identity"
MESSENGER_PASS="parvane-e2e-messenger"
CLOUD_PASS="parvane-e2e-cloud"
NOTES_PASS="parvane-e2e-notes"
CALENDAR_PASS="parvane-e2e-calendar"
CALL_PASS="parvane-e2e-call"
PREVIEW_PASS="parvane-e2e-preview"
GATEWAY_PASS="parvane-e2e-gateway"

log() {
  printf '\n== %s ==\n' "$*"
}

preserve_failure_logs() {
  local destination="$WEB_ROOT/test-results/backend"
  mkdir -p "$destination"
  cp -R "$TEMP_ROOT"/. "$destination"/
  printf 'Backend logs: %s\n' "$destination"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  if (( status != 0 )); then
    preserve_failure_logs
  fi

  case "$TEMP_ROOT" in
    /tmp/parvane-web-e2e.*) find "$TEMP_ROOT" -depth -delete ;;
    *) printf 'Refusing to clean unexpected temp path: %s\n' "$TEMP_ROOT" >&2 ;;
  esac

  exit "$status"
}
trap cleanup EXIT INT TERM

allocate_port NATS_PORT PARVANE_E2E_NATS_PORT
allocate_port GATEWAY_WS_PORT PARVANE_E2E_GATEWAY_WS_PORT
allocate_port GATEWAY_TCP_PORT PARVANE_E2E_GATEWAY_TCP_PORT
allocate_port WEB_PORT PARVANE_E2E_WEB_PORT
allocate_port TURN_PORT PARVANE_E2E_TURN_PORT

wait_for_log() {
  local name="$1"
  local pattern="$2"
  local pid="$3"
  local log_file="$TEMP_ROOT/$name.log"

  for _attempt in {1..300}; do
    if rg -q "$pattern" "$log_file" 2>/dev/null; then
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s exited before becoming ready\n' "$name" >&2
      tail -100 "$log_file" >&2 || true
      return 1
    fi
    sleep 0.1
  done

  printf 'Timed out waiting for %s\n' "$name" >&2
  tail -100 "$log_file" >&2 || true
  return 1
}

start_shard() {
  local shard="$1"
  local password="$2"

  env \
    PARVANE_NATS_URL="nats://127.0.0.1:$NATS_PORT" \
    PARVANE_NATS_USER="$shard" \
    PARVANE_NATS_PASS="$password" \
    PARVANE_DB_PATH="$TEMP_ROOT/$shard.db" \
    PARVANE_LOG_LEVEL=info \
    "$ROOT/target/debug/$shard" >"$TEMP_ROOT/$shard.log" 2>&1 &
  PIDS+=("$!")
}

log "Build backend binaries"
cd "$ROOT"
cargo build -p identity -p messenger -p cloud -p call -p preview -p gateway

log "Start isolated production-like NATS"
env \
  PARVANE_IDENTITY_PASS="$IDENTITY_PASS" \
  PARVANE_MESSENGER_PASS="$MESSENGER_PASS" \
  PARVANE_CLOUD_PASS="$CLOUD_PASS" \
  PARVANE_NOTES_PASS="$NOTES_PASS" \
  PARVANE_CALENDAR_PASS="$CALENDAR_PASS" \
  PARVANE_CALL_PASS="$CALL_PASS" \
  PARVANE_PREVIEW_PASS="$PREVIEW_PASS" \
  PARVANE_GATEWAY_PASS="$GATEWAY_PASS" \
  nats-server -c "$ROOT/infra/nats/server.prod.conf" -a 127.0.0.1 -p "$NATS_PORT" \
  >"$TEMP_ROOT/nats.log" 2>&1 &
PIDS+=("$!")
wait_for_log nats 'Server is ready' "${PIDS[-1]}"

# TURN для relay-теста звонков: pion-сервер с ephemeral-кредами (TURN REST).
# Без go в PATH стек работает как раньше — call-шард отдаст только STUN.
TURN_SECRET="parvane-e2e-turn-secret"
if command -v go >/dev/null 2>&1; then
  log "Build and start TURN server"
  (cd "$ROOT/infra/turn" && go build -o "$TEMP_ROOT/parvane-turn" .)
  env \
    TURN_PUBLIC_IP=127.0.0.1 \
    TURN_PORT="$TURN_PORT" \
    TURN_SECRET="$TURN_SECRET" \
    "$TEMP_ROOT/parvane-turn" >"$TEMP_ROOT/turn.log" 2>&1 &
  PIDS+=("$!")
  wait_for_log turn 'Parvane TURN' "${PIDS[-1]}"
  CALL_ICE_ENV=(
    PARVANE_STUN_URLS="stun:127.0.0.1:$TURN_PORT"
    PARVANE_TURN_URL="turn:127.0.0.1:$TURN_PORT"
    PARVANE_TURN_SECRET="$TURN_SECRET"
    PARVANE_TURN_TTL_SECS=600
  )
  export PARVANE_E2E_TURN=1
  export PARVANE_E2E_TURN_PORT="$TURN_PORT"
  export PARVANE_E2E_TURN_SECRET="$TURN_SECRET"
else
  CALL_ICE_ENV=()
fi

log "Start shards with temporary databases"
start_shard identity "$IDENTITY_PASS"
start_shard messenger "$MESSENGER_PASS"
start_shard cloud "$CLOUD_PASS"
if (( ${#CALL_ICE_ENV[@]} )); then
  export "${CALL_ICE_ENV[@]}"
fi
start_shard call "$CALL_PASS"
start_shard preview "$PREVIEW_PASS"

wait_for_log identity 'Identity шард запущен' "${PIDS[-5]}"
wait_for_log messenger 'Messenger шард запущен' "${PIDS[-4]}"
wait_for_log cloud 'Cloud шард запущен' "${PIDS[-3]}"
wait_for_log call 'Call шард запущен' "${PIDS[-2]}"
wait_for_log preview 'Preview шард запущен' "${PIDS[-1]}"

if rg -n 'Permissions Violation|authorization violation' "$TEMP_ROOT"/*.log; then
  printf 'Production ACL rejected a shard subscription\n' >&2
  exit 1
fi

log "Start gateway"
env \
  PARVANE_NATS_URL="nats://127.0.0.1:$NATS_PORT" \
  PARVANE_NATS_USER=gateway \
  PARVANE_NATS_PASS="$GATEWAY_PASS" \
  PARVANE_GATEWAY_BIND="127.0.0.1:$GATEWAY_WS_PORT" \
  PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$GATEWAY_TCP_PORT" \
  PARVANE_LOG_LEVEL=info \
  "$ROOT/target/debug/gateway" >"$TEMP_ROOT/gateway.log" 2>&1 &
PIDS+=("$!")
wait_for_log gateway 'Gateway WebSocket' "${PIDS[-1]}"

if [[ -n "${PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT:-}" ]]; then
  log "Build and start production Web"
  cd "$WEB_ROOT"
  if [[ "${PARVANE_E2E_SKIP_WEB_BUILD:-0}" != "1" ]]; then
    npm run build:production
  fi
  node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort \
    >"$TEMP_ROOT/web.log" 2>&1 &
  PIDS+=("$!")
  wait_for_log web "http://127.0.0.1:$WEB_PORT" "${PIDS[-1]}"

  log "Run external browser e2e"
  cd "$ROOT"
  PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:$GATEWAY_WS_PORT" \
  PARVANE_E2E_GATEWAY_TCP_URL="127.0.0.1:$GATEWAY_TCP_PORT" \
  PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" \
  node "$PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT"
else
  log "Run browser e2e"
  cd "$WEB_ROOT"
  PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:$GATEWAY_WS_PORT" \
  PARVANE_E2E_WEB_PORT="$WEB_PORT" \
  npm run test:playwright:run -- "$@"
fi
