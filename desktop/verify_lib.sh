#!/usr/bin/env bash
# Parvane — общая обвязка desktop-e2e (мультидевайс/линковка/devices/email/edit).
# Поднимает nats + шарды (identity, messenger, cloud, call) + gateway в $SB,
# даёт ok/bad/start_client/wait_log/stop_all. Источник: . verify_lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_paths.sh"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
PIDS=()
stack_start() { # stack_start <scratch> [env-для-identity]
  SB="$1"; shift
  rm -rf "$SB"; mkdir -p "$SB"
  [ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
  for s in identity messenger cloud call gateway; do
    [ -x "$SHARD/$s" ] || { echo "нет шарда $SHARD/$s — cargo build"; exit 2; }
  done
  nats-server -p 4222 >"$SB/nats.log" 2>&1 & PIDS+=($!)
  sleep 1
  # headless-клиенты перелогиниваются ~1-2 раза/с с 127.0.0.1 — лимиты по IP
  # и логину (identity) для e2e снимаем, иначе через ~15 с интро замирает
  env PARVANE_LOGIN_RATE=100000 PARVANE_LOGIN_RATE_IP=100000 \
    PARVANE_REGISTER_RATE=100000 PARVANE_REGISTER_RATE_IP=100000 PARVANE_REGISTER_RATE_GLOBAL=100000 \
    "$@" PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/identity.db" \
    PARVANE_LOG_LEVEL=info "$SHARD/identity" >"$SB/identity.log" 2>&1 & PIDS+=($!)
  for s in messenger cloud call; do
    PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" \
      PARVANE_LOG_LEVEL=info "$SHARD/$s" >"$SB/$s.log" 2>&1 & PIDS+=($!)
  done
  gateway_start
  sleep 2
}
# gateway отдельно (перезапуск с другими лимитами: PV_GATEWAY_ENV="A=1 B=2")
GW_PID=""
gateway_start() {
  # shellcheck disable=SC2086
  env ${PV_GATEWAY_ENV:-} PARVANE_NATS_URL=nats://127.0.0.1:4222 \
    PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 \
    PARVANE_LOG_LEVEL=info "$SHARD/gateway" >>"$SB/gateway.log" 2>&1 & GW_PID=$!
  PIDS+=($GW_PID)
}
gateway_restart() { kill "$GW_PID" 2>/dev/null; wait "$GW_PID" 2>/dev/null; sleep 1; gateway_start; sleep 2; }
# start_client <workdir> <user@server> [ENV=VAL ...] → pid; лог: <workdir>/td/log.txt
start_client() {
  local work="$1" user="$2"; shift 2
  mkdir -p "$work/td"
  # tdesktop переписывает log.txt при каждом старте — прошлый прогон сохраняем
  [ -f "$work/td/log.txt" ] && mv "$work/td/log.txt" "$work/td/log.$(date +%s%N).txt"
  env "$@" QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
    PARVANE_AUTOLOGIN="$user:test" "$BIN" -workdir "$work/td" \
    >>"$work/stdout.log" 2>&1 &
  echo $!
}
# wait_log <file> <regex> [secs=40] → 0 если дождались
wait_log() {
  local f="$1" re="$2" n="${3:-40}"
  for _ in $(seq 1 "$n"); do
    grep -qE "$re" "$f" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
stop_pid() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
stack_stop() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
finish() { # finish <имя>
  [ "$RC" -eq 0 ] && printf '\033[32m%s: OK\033[0m\n' "$1" || printf '\033[31m%s: ЕСТЬ ПРОВАЛЫ\033[0m\n' "$1"
  exit "$RC"
}
