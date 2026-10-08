#!/usr/bin/env bash

set -Eeuo pipefail
# Хуки window.__parvane* для пробников — только в e2e/demo-сборках
export VITE_PARVANE_DIAG_HOOKS=1
# CSP (P-32): диагностическая сборка e2e ходит в локальный gateway на
# динамическом порту — разрешаем только loopback
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"

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
PUSH_PASS="parvane-e2e-push"
DOMAINS_PASS="parvane-e2e-domains"
GATEWAY_PASS="parvane-e2e-gateway"

log() {
  printf '\n== %s ==\n' "$*"
}

preserve_failure_logs() {
  # Параллельные прогоны затирали общий каталог — его можно переопределить
  local destination="${PARVANE_E2E_FAILURE_LOG_DIR:-$WEB_ROOT/test-results/backend}"
  mkdir -p "$destination"
  cp -R "$TEMP_ROOT"/. "$destination"/
  printf 'Backend logs: %s\n' "$destination"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  # Перезапущенные посреди сценария gateway и identity (см. gateway_restart_watch)
  for restarted in gateway identity; do
    if [[ -s "$TEMP_ROOT/$restarted.pid" ]]; then
      kill "$(cat "$TEMP_ROOT/$restarted.pid")" 2>/dev/null || true
    fi
  done
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

  for _attempt in {1..900}; do
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
    PARVANE_LOGIN_RATE_IP=100000 \
    PARVANE_REGISTER_RATE_IP=100000 \
    PARVANE_CALL_V2_RINGING_MAX="${PARVANE_E2E_RINGING_MAX:-100000}" \
    "$ROOT/backend/target/debug/$shard" >>"$TEMP_ROOT/$shard.log" 2>&1 &
  PIDS+=("$!")
  echo "$!" >"$TEMP_ROOT/$shard.pid"
}

log "Build backend binaries"
cargo build --manifest-path "$ROOT/backend/Cargo.toml" -p identity -p messenger -p cloud -p call -p preview -p push -p domains -p gateway

log "Start isolated production-like NATS"
env \
  PARVANE_IDENTITY_PASS="$IDENTITY_PASS" \
  PARVANE_MESSENGER_PASS="$MESSENGER_PASS" \
  PARVANE_CLOUD_PASS="$CLOUD_PASS" \
  PARVANE_NOTES_PASS="$NOTES_PASS" \
  PARVANE_CALENDAR_PASS="$CALENDAR_PASS" \
  PARVANE_CALL_PASS="$CALL_PASS" \
  PARVANE_PREVIEW_PASS="$PREVIEW_PASS" \
  PARVANE_PUSH_PASS="$PUSH_PASS" \
  PARVANE_DOMAINS_PASS="$DOMAINS_PASS" \
  PARVANE_GATEWAY_PASS="$GATEWAY_PASS" \
  nats-server -c "$ROOT/backend/infra/nats/server.prod.conf" -a 127.0.0.1 -p "$NATS_PORT" \
  >"$TEMP_ROOT/nats.log" 2>&1 &
PIDS+=("$!")
wait_for_log nats 'Server is ready' "${PIDS[-1]}"

# TURN для relay-теста звонков: pion-сервер с ephemeral-кредами (TURN REST).
# Без go в PATH стек работает как раньше — call-шард отдаст только STUN.
TURN_SECRET="parvane-e2e-turn-secret"
if command -v go >/dev/null 2>&1; then
  log "Build and start TURN server"
  (cd "$ROOT/backend/infra/turn" && go build -o "$TEMP_ROOT/parvane-turn" .)
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
start_shard push "$PUSH_PASS"
start_shard domains "$DOMAINS_PASS"

wait_for_log identity 'Identity шард запущен' "${PIDS[-7]}"
wait_for_log messenger 'Messenger шард запущен' "${PIDS[-6]}"
wait_for_log cloud 'Cloud шард запущен' "${PIDS[-5]}"
wait_for_log call 'Call шард запущен' "${PIDS[-4]}"
wait_for_log preview 'Preview шард запущен' "${PIDS[-3]}"
wait_for_log push 'Push шард запущен' "${PIDS[-2]}"
wait_for_log domains 'Domains шард запущен' "${PIDS[-1]}"

if rg -n 'Permissions Violation|authorization violation' "$TEMP_ROOT"/*.log; then
  printf 'Production ACL rejected a shard subscription\n' >&2
  exit 1
fi

# $1 — дополнительное окружение gateway (строка «ИМЯ=значение …»)
start_gateway() {
  env \
    PARVANE_NATS_URL="nats://127.0.0.1:$NATS_PORT" \
    PARVANE_NATS_USER=gateway \
    PARVANE_NATS_PASS="$GATEWAY_PASS" \
    PARVANE_GATEWAY_BIND="127.0.0.1:$GATEWAY_WS_PORT" \
    PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$GATEWAY_TCP_PORT" \
    PARVANE_LOG_LEVEL=info \
    $1 \
    "$ROOT/backend/target/debug/gateway" >>"$TEMP_ROOT/gateway.log" 2>&1 &
  echo "$!" >"$TEMP_ROOT/gateway.pid"
}

# Перезапуск gateway посреди сценария с другим окружением. Сценарий пишет окружение
# нового gateway в файл `gateway.restart` каталога PARVANE_E2E_BACKEND_LOG_DIR и ждёт
# файл `gateway.restarted`.
# Журнал прежнего gateway остаётся в gateway.log, отметка — строка «== gateway restart»
# Так же перезапускается identity (файл `identity.restart` → `identity.restarted`):
# сценарий перед этим удаляет `identity-jwt-ed25519.pem`, и шард поднимается с
# новым ключом подписи JWT — все выданные токены перестают приниматься
identity_restart_if_asked() {
  [[ -f "$TEMP_ROOT/identity.restart" ]] || return 0
  rm -f "$TEMP_ROOT/identity.restart"
  kill "$(cat "$TEMP_ROOT/identity.pid")" 2>/dev/null || true
  while kill -0 "$(cat "$TEMP_ROOT/identity.pid")" 2>/dev/null; do sleep 0.1; done
  printf '== identity restart\n' >>"$TEMP_ROOT/identity.log"
  local lines
  lines="$(wc -l <"$TEMP_ROOT/identity.log")"
  start_shard identity "$IDENTITY_PASS"
  for _attempt in {1..300}; do
    tail -n +"$((lines + 1))" "$TEMP_ROOT/identity.log" | rg -q 'Identity шард запущен' && break
    sleep 0.1
  done
  : >"$TEMP_ROOT/identity.restarted"
}

gateway_restart_watch() {
  while sleep 0.3; do
    identity_restart_if_asked
    [[ -f "$TEMP_ROOT/gateway.restart" ]] || continue
    local extra
    extra="$(cat "$TEMP_ROOT/gateway.restart")"
    rm -f "$TEMP_ROOT/gateway.restart"
    kill "$(cat "$TEMP_ROOT/gateway.pid")" 2>/dev/null || true
    while kill -0 "$(cat "$TEMP_ROOT/gateway.pid")" 2>/dev/null; do sleep 0.1; done
    printf '== gateway restart: %s\n' "$extra" >>"$TEMP_ROOT/gateway.log"
    local lines
    lines="$(wc -l <"$TEMP_ROOT/gateway.log")"
    start_gateway "$extra"
    for _attempt in {1..300}; do
      tail -n +"$((lines + 1))" "$TEMP_ROOT/gateway.log" | rg -q 'Gateway WebSocket' && break
      sleep 0.1
    done
    : >"$TEMP_ROOT/gateway.restarted"
  done
}

log "Start gateway"
: >"$TEMP_ROOT/gateway.log"
start_gateway "${PARVANE_E2E_GATEWAY_ENV:-}"
wait_for_log gateway 'Gateway WebSocket' "$(cat "$TEMP_ROOT/gateway.pid")"
gateway_restart_watch &
PIDS+=("$!")

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
  PARVANE_E2E_NATS_URL="nats://gateway:$GATEWAY_PASS@127.0.0.1:$NATS_PORT" \
  PARVANE_E2E_BACKEND_LOG_DIR="$TEMP_ROOT" \
  node "$PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT"
else
  log "Run browser e2e"
  cd "$WEB_ROOT"
  PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:$GATEWAY_WS_PORT" \
  PARVANE_E2E_WEB_PORT="$WEB_PORT" \
  npm run test:playwright:run -- "$@"
fi
