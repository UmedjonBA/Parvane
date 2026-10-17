#!/usr/bin/env bash
# Федерация (spec 028) в браузере: два сервера — A (обычный стек run_web_e2e.sh + шард federation) и B
# (свой nats, шарды, federation, gateway). Одна сборка web: Аня ходит в gateway A, Борис — в gateway B.
# Связь серверов — тестовый транспорт (http к loopback, фича insecure-test-transport).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
B_ROOT="$(mktemp -d /tmp/parvane-web-fed-b.XXXXXX)"
B_PIDS=()

port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

cleanup_b() {
  for pid in "${B_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [[ -n "${PARVANE_E2E_FAILURE_LOG_DIR:-}" ]]; then
    mkdir -p "$PARVANE_E2E_FAILURE_LOG_DIR/server-b" && cp "$B_ROOT"/*.log "$PARVANE_E2E_FAILURE_LOG_DIR/server-b/" 2>/dev/null || true
  fi
  rm -rf "$B_ROOT"
}
trap cleanup_b EXIT

A_DOMAIN="a.parvane.test"
B_DOMAIN="b.parvane.test"
A_FED="$(port)"
B_FED="$(port)"
B_NATS="$(port)"
B_WS="$(port)"
B_TCP="$(port)"

if [[ "${PARVANE_E2E_SKIP_BACKEND_BUILD:-0}" != "1" ]]; then
  cargo build --manifest-path "$ROOT/backend/Cargo.toml" -p identity -p messenger -p cloud -p call -p domains -p gateway
  cargo build --manifest-path "$ROOT/backend/Cargo.toml" -p federation --features insecure-test-transport
fi

echo "== server B: nats :$B_NATS, gateway :$B_WS, federation :$B_FED"
nats-server -a 127.0.0.1 -p "$B_NATS" >"$B_ROOT/nats.log" 2>&1 &
B_PIDS+=("$!")
sleep 0.5

start_b() {
  local shard="$1"
  shift
  env \
    PARVANE_NATS_URL="nats://127.0.0.1:$B_NATS" \
    PARVANE_DB_PATH="$B_ROOT/$shard.db" \
    PARVANE_DOMAIN="$B_DOMAIN" \
    PARVANE_FEDERATION=on \
    PARVANE_WELL_KNOWN_FILE="$B_ROOT/parvane.json" \
    PARVANE_S2S_ENDPOINT="http://127.0.0.1:$B_FED" \
    PARVANE_LOG_LEVEL=info \
    PARVANE_LOGIN_RATE_IP=100000 \
    PARVANE_REGISTER_RATE_IP=100000 \
    PARVANE_REQUIRE_DEVICE_PROOF=1 \
    "$@" \
    "$ROOT/backend/target/debug/$shard" >>"$B_ROOT/$shard.log" 2>&1 &
  B_PIDS+=("$!")
}

wait_b() {
  for _ in {1..600}; do
    grep -q "$2" "$B_ROOT/$1.log" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "server B: $1 не поднялся" >&2
  tail -50 "$B_ROOT/$1.log" >&2 || true
  return 1
}

for shard in identity messenger cloud call domains; do start_b "$shard"; done
start_b federation PARVANE_FEDERATION_BIND="127.0.0.1:$B_FED" \
  PARVANE_FEDERATION_ENDPOINTS="$A_DOMAIN=http://127.0.0.1:$A_FED" PARVANE_FEDERATION_INSECURE_HTTP=1
start_b gateway PARVANE_GATEWAY_BIND="127.0.0.1:$B_WS" PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$B_TCP"
wait_b identity 'Identity шард запущен'
wait_b messenger 'Messenger шард запущен'
wait_b domains 'Domains шард запущен'
wait_b federation 'Federation шард запущен'
wait_b gateway 'Gateway WebSocket'

# Сервер A — обычный стек сценариев с доменом A и шардом federation
export PARVANE_DOMAIN="$A_DOMAIN"
export PARVANE_FEDERATION=on
export PARVANE_S2S_ENDPOINT="http://127.0.0.1:$A_FED"
export PARVANE_FEDERATION_ENDPOINTS="$B_DOMAIN=http://127.0.0.1:$B_FED"
export PARVANE_E2E_FEDERATION_PORT="$A_FED"
export PARVANE_E2E_GATEWAY_URL_B="ws://127.0.0.1:$B_WS"
export PARVANE_E2E_DOMAIN_A="$A_DOMAIN"
export PARVANE_E2E_DOMAIN_B="$B_DOMAIN"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_federation.mjs" "$ROOT/scripts/run_web_e2e.sh"
