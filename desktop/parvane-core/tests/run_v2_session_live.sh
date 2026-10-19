#!/usr/bin/env bash
# Протокол v2 (spec 007, T064; spec 029, T026): C++-тест v2-сессии parvane-core против живого
# изолированного стека — nats + identity + messenger + cloud + call + domains + federation + gateway
# на свободных портах (не мешает другим стекам на 4222/9222/9223), временные БД.
# Второй такой же стек (домен fed.parvane.test, свой nats) — для федерации (M31, FED-1): оба
# шарда federation знают вход соседа по тестовому HTTP-транспорту (бинарь собран с
# `--features insecure-test-transport`). Отдельный gateway с PARVANE_V2_MIN_MINOR=999 — для
# «нужна новая версия» (M36). Стек identity — с PARVANE_REQUIRE_DEVICE_PROOF=1 (ID-01) и
# ключом администратора для жалоб (spec 024).
# Нужны: nats-server в PATH (или ~/.local/bin), собранные шарды
# backend/target/debug/{identity,messenger,cloud,call,domains,federation,gateway} и тест
# parvane-core/build/parvane_v2_session_tests.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../verify_paths.sh"
TEST_BIN="${PARVANE_V2_TEST_BIN:-$HERE/../build/parvane_v2_session_tests}"
export PATH="$HOME/.local/bin:$PATH"
command -v nats-server >/dev/null || { echo "нет nats-server"; exit 2; }
[ -x "$TEST_BIN" ] || { echo "нет $TEST_BIN — cmake --build parvane-core/build --target parvane_v2_session_tests"; exit 2; }
for s in identity messenger cloud call domains gateway; do
  [ -x "$SHARD/$s" ] || { echo "нет шарда $SHARD/$s — cargo build -p $s"; exit 2; }
done
# Федерация — только если шард собран (с тестовым транспортом); иначе тест пропускает M31
FED=1
[ -x "$SHARD/federation" ] || { echo "нет шарда $SHARD/federation — федерация (M31) пропускается"; FED=0; }
# Ключ администратора для жалоб (spec 024) — тестовая пара verify_lib.sh / web-e2e
REPORT_KEY="${PV_REPORT_PUBLIC_KEY:-HdJ5hOKvSb97IDT0GBi_sqoYEWuTk0SbNQp0yhReHHc}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
SB="$(mktemp -d /tmp/parvane-v2-live-XXXXXX)"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT
wait_log() { # wait_log <файл> <строка> [секунд]
  for _ in $(seq 1 $(( ${3:-60} * 2 ))); do grep -qa "$2" "$1" 2>/dev/null && return 0; sleep 0.5; done
  return 1
}
UNLIMITED=(PARVANE_LOGIN_RATE=100000 PARVANE_LOGIN_RATE_IP=100000 PARVANE_REGISTER_RATE=100000
  PARVANE_REGISTER_RATE_IP=100000 PARVANE_REGISTER_RATE_GLOBAL=100000 PARVANE_V2_BUNDLE_RATE=100000)

# start_stack <имя> <домен> <nats-порт> <tcp-порт> <ws-порт> <fed-порт|""> <соседи|"">
# Каталог $SB/<имя>; логи там же. Все шарды — PARVANE_DOMAIN=<домен>.
start_stack() {
  local name="$1" domain="$2" np="$3" tp="$4" wp="$5" fp="$6" peers="$7"
  local d="$SB/$name"; mkdir -p "$d"
  nats-server -a 127.0.0.1 -p "$np" >"$d/nats.log" 2>&1 & PIDS+=($!)
  sleep 0.5
  local nats="nats://127.0.0.1:$np"
  local fed=()
  [ -n "$fp" ] && fed=(PARVANE_FEDERATION=on PARVANE_S2S_ENDPOINT="http://127.0.0.1:$fp")
  env "${UNLIMITED[@]}" PARVANE_DEV=1 "${fed[@]}" \
    PARVANE_REQUIRE_DEVICE_PROOF="${PARVANE_REQUIRE_DEVICE_PROOF:-1}" \
    PARVANE_REPORT_PUBLIC_KEY="$REPORT_KEY" PARVANE_DOMAIN="$domain" \
    PARVANE_NATS_URL="$nats" PARVANE_DB_PATH="$d/identity.db" PARVANE_WELL_KNOWN_FILE="$d/parvane.json" \
    PARVANE_LOG_LEVEL=info "$SHARD/identity" >"$d/identity.log" 2>&1 & PIDS+=($!)
  local s
  for s in messenger cloud domains; do
    env "${fed[@]}" PARVANE_DOMAIN="$domain" PARVANE_NATS_URL="$nats" PARVANE_DB_PATH="$d/$s.db" \
      PARVANE_LOG_LEVEL=info "$SHARD/$s" >"$d/$s.log" 2>&1 & PIDS+=($!)
  done
  # call — сигналы звонков v2 (T185: попарный сигнал группового звонка)
  env "${fed[@]}" PARVANE_DOMAIN="$domain" PARVANE_NATS_URL="$nats" PARVANE_DB_PATH="$d/call.db" \
    PARVANE_CALL_V2_RINGING_MAX=100000 PARVANE_LOG_LEVEL=info "$SHARD/call" >"$d/call.log" 2>&1 & PIDS+=($!)
  if [ -n "$fp" ]; then
    env "${fed[@]}" PARVANE_DOMAIN="$domain" PARVANE_NATS_URL="$nats" PARVANE_DB_PATH="$d/federation.db" \
      PARVANE_WELL_KNOWN_FILE="$d/parvane.json" PARVANE_FEDERATION_BIND="127.0.0.1:$fp" \
      PARVANE_FEDERATION_ENDPOINTS="$peers" PARVANE_FEDERATION_INSECURE_HTTP=1 \
      PARVANE_LOG_LEVEL=info "$SHARD/federation" >"$d/federation.log" 2>&1 & PIDS+=($!)
  fi
  env "${fed[@]}" PARVANE_DOMAIN="$domain" PARVANE_NATS_URL="$nats" PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$tp" \
    PARVANE_GATEWAY_BIND="127.0.0.1:$wp" PARVANE_V2_FEATURES=sealed PARVANE_GATEWAY_MAX_CONNS_PER_IP=10000 \
    PARVANE_LOG_LEVEL=info "$SHARD/gateway" >"$d/gateway.log" 2>&1 & PIDS+=($!)
  for s in identity messenger cloud call domains ${fp:+federation}; do
    local cap; cap="$(echo "${s:0:1}" | tr a-z A-Z)${s:1}"
    wait_log "$d/$s.log" "$cap шард запущен" 60 || { echo "шард $s стека $name не поднялся (см. $d/$s.log)"; return 1; }
  done
  for _ in $(seq 1 60); do (exec 3<>"/dev/tcp/127.0.0.1/$tp") 2>/dev/null && break; sleep 0.5; done
}

NP=$(free_port); TP=$(free_port); WP=$(free_port); FA=$(free_port); UP=$(free_port)
NP2=$(free_port); TP2=$(free_port); WP2=$(free_port); FB=$(free_port)
FED_DOMAIN="fed.parvane.test"
if [ "$FED" = 1 ]; then
  start_stack a local "$NP" "$TP" "$WP" "$FA" "$FED_DOMAIN=http://127.0.0.1:$FB" || exit 2
  start_stack b "$FED_DOMAIN" "$NP2" "$TP2" "$WP2" "$FB" "local=http://127.0.0.1:$FA" || exit 2
else
  start_stack a local "$NP" "$TP" "$WP" "" "" || exit 2
fi
# Gateway «только новые клиенты» (M36): минимальная минорная версия выше любой существующей
env PARVANE_DOMAIN=local PARVANE_NATS_URL="nats://127.0.0.1:$NP" PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$UP" \
  PARVANE_GATEWAY_BIND="127.0.0.1:$(free_port)" PARVANE_V2_FEATURES=sealed PARVANE_V2_MIN_MINOR=999 \
  PARVANE_LOG_LEVEL=info "$SHARD/gateway" >"$SB/a/gateway-upgrade.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do (exec 3<>"/dev/tcp/127.0.0.1/$UP") 2>/dev/null && break; sleep 0.5; done
sleep 1
PARVANE_GATEWAY_TCP="127.0.0.1:$TP" PARVANE_V2_WS_URL="ws://127.0.0.1:$WP/ws" \
  PARVANE_V2_UPGRADE_TCP="127.0.0.1:$UP" \
  PARVANE_V2_FED_TCP="$([ "$FED" = 1 ] && echo "127.0.0.1:$TP2")" PARVANE_V2_FED_DOMAIN="$FED_DOMAIN" \
  "$TEST_BIN"
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "--- хвосты логов стека ($SB) ---"
  for f in "$SB"/*/*.log; do echo "## $f"; tail -15 "$f"; done
else
  rm -rf "$SB"
fi
exit "$RC"
