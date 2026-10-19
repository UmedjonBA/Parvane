#!/usr/bin/env bash
# Parvane — общая обвязка desktop-e2e. Клиент говорит ТОЛЬКО по протоколу v2
# через gateway (spec 029: v1, прямой NATS и Olm/Megolm из клиента удалены).
# Стек как у web-e2e (`scripts/run_web_e2e.sh`) и прода (compose): NATS с
# продовым конфигом ACL (`backend/infra/nats/server.prod.conf`, пароли ролей),
# шарды identity, messenger, cloud, call, preview, push, domains + gateway
# (WS 9222 / TCP 9223); identity требует доказательство ключа устройства
# (PARVANE_REQUIRE_DEVICE_PROOF=1, как на проде с 17 окт 2026).
# Даёт ok/bad/start_client/wait_log/stop_pid/stack_*/finish. Источник: . verify_lib.sh
# ВАЖНО: бинарь tdesktop должен быть собран с -DPARVANE_DEV=ON — иначе
# PARVANE_AUTO*/PARVANE_GATEWAY_URL=host:port игнорируются (P-45/P-46).
#
# Настройки окружения:
#   PV_GATEWAY_ENV="A=1 B=2"  — дополнительное окружение gateway (и при gateway_restart);
#   PV_SHARD_ENV="A=1 B=2"    — дополнительное окружение ВСЕХ шардов;
#   PV_DOMAIN=local           — домен сервера (PARVANE_DOMAIN всех шардов и gateway);
#   PV_NATS_ACL=0             — NATS без ACL (только для старых android-сценариев,
#                               которые ходят в шину `nats req` напрямую);
#   PV_FEDERATION_PORT=<порт> — поднять ещё шард federation (HTTP без TLS: бинарь
#                               собран с `--features insecure-test-transport`); всем
#                               шардам — PARVANE_FEDERATION=on и PARVANE_S2S_ENDPOINT;
#   PV_FEDERATION_PEERS="<домен>=http://127.0.0.1:<порт>,…" — входы федерации соседей;
#   PV_NATS_PORT=4222, PV_GW_WS_PORT=9222, PV_GW_TCP_PORT=9223 — порты стека; второй
#                               стек в том же сценарии (федерация, verify_federation.sh) —
#                               другие порты, свой PV_DOMAIN и свой каталог SB.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_paths.sh"
RC=0
PV_DOMAIN="${PV_DOMAIN:-local}"
PV_NATS_PORT="${PV_NATS_PORT:-4222}"
PV_GW_WS_PORT="${PV_GW_WS_PORT:-9222}"
PV_GW_TCP_PORT="${PV_GW_TCP_PORT:-9223}"
# Адрес группы v2 (v2g:<hex>) по имени из лога создателя.
group_gid() { # group_gid <log> <имя>
  grep -a "группа v2 '$2' создана" "$1" 2>/dev/null | grep -oE 'v2g:[0-9a-f]{32}' | head -1
}
# Последняя строка «группа <gid> обновлена (…)» в логе клиента: версия, права,
# роль самого клиента, заявки и админы — состояние группы глазами участника.
group_line() { # group_line <log> <gid>
  grep -a "Parvane: группа $2 обновлена" "$1" 2>/dev/null | tail -1
}
# Окружение устройств одного аккаунта: второе устройство обязано быть привязано
# (LINK-1 v2) — старое выдаёт грант без UI (PARVANE_AUTOLINK_GRANT=1), новое
# публикует оффер само и ждёт гранта (wait_linked).
PV_DEV_OLD=(PARVANE_AUTOLINK_GRANT=1)
PV_DEV_NEW=(PARVANE_AUTOLINK_GRANT=1)
wait_linked() { # wait_linked <log нового устройства> [сек=90]
  wait_log "$1" "v2: устройство привязано грантом линковки" "${2:-90}" && wait_log "$1" "v2: готов" 60
}
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
PIDS=()
# Пароли ролей NATS (как в run_web_e2e.sh; только для локального стека)
PV_NATS_ROLES="identity messenger cloud notes calendar call preview push domains federation gateway"
nats_pass() { echo "parvane-desk-e2e-$1"; }
# Открытый ключ администратора для жалоб (spec 024) — тестовая пара, закрытая часть
# в scripts/e2e_report_admin.key (тот же ключ, что у web-e2e)
PV_REPORT_PUBLIC_KEY="${PV_REPORT_PUBLIC_KEY:-HdJ5hOKvSb97IDT0GBi_sqoYEWuTk0SbNQp0yhReHHc}"
# Гасит ТОЛЬКО стек desktop-e2e: nats на $PV_NATS_PORT и шарды, подключённые к нему.
# Не по имени процесса (`pkill -x identity`) — рядом могут идти web-e2e со своими
# шардами из тех же бинарей на других портах.
stack_pids() { # stack_pids <имя-шарда|все>
  local p names="${1:-identity|messenger|cloud|call|gateway|preview|push|domains|federation}"
  for p in $(pgrep -x "$names" 2>/dev/null); do
    tr '\0' '\n' <"/proc/$p/environ" 2>/dev/null \
      | grep -qx "PARVANE_NATS_URL=nats://127.0.0.1:$PV_NATS_PORT" && echo "$p"
  done
}
stack_reap() {
  local p
  for p in $(stack_pids); do kill "$p" 2>/dev/null; done
  for p in $(pgrep -x nats-server 2>/dev/null); do
    tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- "-p $PV_NATS_PORT " && kill "$p" 2>/dev/null
  done
  for _ in $(seq 1 25); do
    (exec 3<>/dev/tcp/127.0.0.1/"$PV_NATS_PORT") 2>/dev/null || return 0
    sleep 0.2
  done
}
# ждём, пока порт начнёт принимать соединения (вместо sleep наугад)
wait_port() { # wait_port <port> [попыток по 0.2 с = 50]
  for _ in $(seq 1 "${2:-50}"); do
    (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null && return 0
    sleep 0.2
  done
  return 1
}
# Запуск одного шарда: shard_start <шард> [ENV=VAL ...] (ENV из аргументов — после
# умолчаний, переопределяют их). Окружение — как start_shard в run_web_e2e.sh.
shard_start() {
  local s="$1"; shift
  local creds=()
  [ "${PV_NATS_ACL:-1}" = 1 ] && creds=(PARVANE_NATS_USER="$s" PARVANE_NATS_PASS="$(nats_pass "$s")")
  # Федерация (spec 028): identity описывает свой вход s2s в server.describe
  local fed=()
  [ -n "${PV_FEDERATION_PORT:-}" ] && fed=(PARVANE_FEDERATION=on PARVANE_S2S_ENDPOINT="http://127.0.0.1:$PV_FEDERATION_PORT")
  # shellcheck disable=SC2086
  env PARVANE_NATS_URL="nats://127.0.0.1:$PV_NATS_PORT" "${creds[@]}" "${fed[@]}" \
    PARVANE_DB_PATH="$SB/$s.db" \
    PARVANE_WELL_KNOWN_FILE="$SB/parvane.json" \
    PARVANE_DOMAIN="$PV_DOMAIN" \
    PARVANE_LOG_LEVEL=info \
    PARVANE_LOGIN_RATE_IP=100000 \
    PARVANE_REGISTER_RATE_IP=100000 \
    PARVANE_CALL_V2_RINGING_MAX=100000 \
    PARVANE_REQUIRE_DEVICE_PROOF=1 \
    PARVANE_REPORT_PUBLIC_KEY="$PV_REPORT_PUBLIC_KEY" \
    ${PV_SHARD_ENV:-} "$@" "$SHARD/$s" >>"$SB/$s.log" 2>&1 & PIDS+=($!)
}
# stack_up <scratch> [env-для-identity] — поднять стек, НЕ очищая каталог
# (скрипт уже разложил в нём профили/файлы); stack_start — то же с очисткой.
stack_up() {
  SB="$1"; shift
  mkdir -p "$SB"
  [ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
  local s
  for s in identity messenger cloud call preview push domains gateway; do
    [ -x "$SHARD/$s" ] || { echo "нет шарда $SHARD/$s — cargo build -p $s"; exit 2; }
  done
  if [ -n "${PV_FEDERATION_PORT:-}" ] && [ ! -x "$SHARD/federation" ]; then
    echo "нет шарда $SHARD/federation — cargo build -p federation --features insecure-test-transport"; exit 2
  fi
  command -v nats-server >/dev/null || { echo "нет nats-server в PATH"; exit 2; }
  stack_reap   # хвост прошлого прогона на тех же портах
  if [ "${PV_NATS_ACL:-1}" = 1 ]; then
    local penv=() r
    for r in $PV_NATS_ROLES; do penv+=("PARVANE_$(echo "$r" | tr a-z A-Z)_PASS=$(nats_pass "$r")"); done
    env "${penv[@]}" nats-server -c "$ROOT/../backend/infra/nats/server.prod.conf" -a 127.0.0.1 -p "$PV_NATS_PORT" \
      >"$SB/nats.log" 2>&1 & PIDS+=($!)
  else
    nats-server -a 127.0.0.1 -p "$PV_NATS_PORT" >"$SB/nats.log" 2>&1 & PIDS+=($!)
  fi
  wait_port "$PV_NATS_PORT" || { echo "nats-server не поднялся (см. $SB/nats.log)"; exit 2; }
  # headless-клиенты перелогиниваются ~1-2 раза/с с 127.0.0.1 — лимиты по IP
  # и логину (identity) для e2e снимаем, иначе через ~15 с интро замирает
  shard_start identity PARVANE_LOGIN_RATE=100000 PARVANE_REGISTER_RATE=100000 \
    PARVANE_REGISTER_RATE_GLOBAL=100000 "$@"
  for s in messenger cloud call preview push domains; do shard_start "$s"; done
  if [ -n "${PV_FEDERATION_PORT:-}" ]; then
    shard_start federation PARVANE_FEDERATION_BIND="127.0.0.1:$PV_FEDERATION_PORT" \
      PARVANE_FEDERATION_ENDPOINTS="${PV_FEDERATION_PEERS:-}" PARVANE_FEDERATION_INSECURE_HTTP=1
  fi
  # Диск медленный: клиент, пришедший раньше шарда, получает таймаут входа и не
  # повторяет его — ждём отметку запуска каждого шарда
  for s in identity messenger cloud call preview push domains ${PV_FEDERATION_PORT:+federation}; do
    local name; name="$(echo "${s:0:1}" | tr a-z A-Z)${s:1}"
    wait_log "$SB/$s.log" "$name шард запущен" 60 || { echo "шард $s не поднялся (см. $SB/$s.log)"; exit 2; }
  done
  if grep -qaE 'Permissions Violation|authorization violation' "$SB"/*.log 2>/dev/null; then
    echo "ACL NATS отверг подписку шарда (см. $SB/nats.log)"; exit 2
  fi
  : >>"$SB/gateway.log"
  gateway_start
  wait_port "$PV_GW_TCP_PORT"
  wait_log "$SB/gateway.log" "Gateway WebSocket" 30 || { echo "gateway не поднялся (см. $SB/gateway.log)"; exit 2; }
  sleep 1
}
stack_start() { # stack_start <scratch> [env-для-identity]
  local sb="$1"; shift
  # зомби прошлого прогона с тем же -workdir перехватит новый старт через локальный сокет
  pkill -9 -f -- "-workdir $sb/" 2>/dev/null; sleep 0.5
  rm -rf "$sb"
  stack_up "$sb" "$@"
}
# gateway отдельно (перезапуск с другими лимитами: PV_GATEWAY_ENV="A=1 B=2")
GW_PID=""
gateway_start() {
  local creds=()
  [ "${PV_NATS_ACL:-1}" = 1 ] && creds=(PARVANE_NATS_USER=gateway PARVANE_NATS_PASS="$(nats_pass gateway)")
  # shellcheck disable=SC2086
  env PARVANE_NATS_URL="nats://127.0.0.1:$PV_NATS_PORT" "${creds[@]}" PARVANE_DOMAIN="$PV_DOMAIN" \
    PARVANE_GATEWAY_TCP_BIND="127.0.0.1:$PV_GW_TCP_PORT" PARVANE_GATEWAY_BIND="127.0.0.1:$PV_GW_WS_PORT" \
    PARVANE_LOG_LEVEL=info ${PV_GATEWAY_ENV:-} "$SHARD/gateway" >>"$SB/gateway.log" 2>&1 & GW_PID=$!
  PIDS+=($GW_PID)
}
# Работает и из чужого шелла (стек поднят другим скриптом, GW_PID пуст — так tgx_conformance_flow.sh
# после tgx_link_e2e.sh «перезапускал» gateway, а новый экземпляр падал на занятом порту, 27 сен 2026)
gateway_restart() {
  if [ -n "$GW_PID" ]; then kill "$GW_PID" 2>/dev/null; wait "$GW_PID" 2>/dev/null
  else for _p in $(stack_pids gateway); do kill "$_p" 2>/dev/null; done; fi
  for _ in $(seq 1 50); do [ -z "$(stack_pids gateway)" ] && break; sleep 0.2; done
  sleep 1; gateway_start; sleep 2
  if ! kill -0 "$GW_PID" 2>/dev/null || tail -3 "$SB/gateway.log" | grep -aq "Address already in use"; then bad "gateway не перезапустился (см. $SB/gateway.log)"; fi
}
# Пароль тестовых аккаунтов: сервер требует не короче 8 символов (P-43).
PV_PASSWORD="${PV_PASSWORD:-test-pass-2026}"
# start_client <workdir> <user@server> [ENV=VAL ...] → pid; лог: <workdir>/td/log.txt
# Клиент ходит только через gateway (TCP $PV_GW_TCP_PORT по умолчанию — порт стека на момент
# вызова; WebSocket — PARVANE_GATEWAY_URL=ws://127.0.0.1:9222/ws в аргументах).
start_client() {
  local work="$1" user="$2"; shift 2
  mkdir -p "$work/td"
  # tdesktop переписывает log.txt при каждом старте — прошлый прогон сохраняем
  [ -f "$work/td/log.txt" ] && mv "$work/td/log.txt" "$work/td/log.$(date +%s%N).txt"
  # ENV из аргументов — после умолчаний: вызывающий может их переопределить
  env QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL="127.0.0.1:$PV_GW_TCP_PORT" \
    PARVANE_AUTOLOGIN="$user:$PV_PASSWORD" "$@" "$BIN" -workdir "$work/td" \
    >>"$work/stdout.log" 2>&1 &
  echo $!
}
# pair_exchange <workdir1> <user1> <workdir2> <user2> [ENV=VAL …] — заводит обоих
# (устройство и журнал устройств v2) и обменивается сообщениями в обе стороны;
# по выходу оба клиента остановлены. В v2 звонить можно только тому, с кем уже
# была переписка (ключ доступа собеседника, D-08), — подготовка для звонков.
# ENV из аргументов получают оба клиента.
pair_exchange() {
  local w1="$1" u1="$2" w2="$3" u2="$4"; shift 4
  local s; s="обмен-$(date +%s%N)"
  local p2 p1
  p2=$(start_client "$w2" "$u2" PARVANE_NO_LINK_OFFER=1 "$@")
  wait_log "$w2/td/log.txt" "v2: готов" 90 || bad "pair_exchange: $u2 не поднялся"
  p1=$(start_client "$w1" "$u1" PARVANE_NO_LINK_OFFER=1 "$@" "PARVANE_AUTOSEND=$u2:$s-1")
  wait_log "$w2/td/log.txt" "входящее msg .* \($u1\): $s-1" 90 || bad "pair_exchange: $u2 не получил сообщение $u1"
  stop_pid "$p2"
  p2=$(start_client "$w2" "$u2" PARVANE_NO_LINK_OFFER=1 "$@" "PARVANE_AUTOSEND=$u1:$s-2")
  wait_log "$w1/td/log.txt" "входящее msg .* \($u2\): $s-2" 90 || bad "pair_exchange: $u1 не получил сообщение $u2"
  stop_pid "$p1"; stop_pid "$p2"
}
# wait_log <file> <regex> [secs=40] → 0 если дождались
wait_log() {
  local f="$1" re="$2" n="${3:-40}"
  for _ in $(seq 1 "$n"); do
    grep -qaE "$re" "$f" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
# клиент запускается через PA=$(start_client …) — он не потомок этой оболочки, `wait`
# не ждёт; ждём выхода опросом, иначе следующий старт того же -workdir найдёт живой
# экземпляр через локальный сокет и тихо выйдет (log_startN.txt «not the first instance»)
stop_pid() {
  [ -n "$1" ] || return 0
  kill "$1" 2>/dev/null; wait "$1" 2>/dev/null
  for _ in $(seq 1 50); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.2; done
  kill -9 "$1" 2>/dev/null; sleep 0.5
}
# клиенты этого прогона (по -workdir внутри каталога прогона)
clients_kill() { # clients_kill <каталог>...
  local d
  for d in "$@"; do [ -n "$d" ] && pkill -9 -f -- "-workdir $d/" 2>/dev/null; done
  return 0
}
stack_stop() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; PIDS=(); }
finish() { # finish <имя>
  # Продовый ACL: шард, полезший мимо своих прав, — дефект конфигурации или кода
  if [ -n "${SB:-}" ] && [ -f "$SB/nats.log" ] && grep -qaE 'Permissions Violation' "$SB/nats.log"; then
    bad "NATS ACL: нарушение прав роли (см. $SB/nats.log)"
  fi
  [ "$RC" -eq 0 ] && printf '\033[32m%s: OK\033[0m\n' "$1" || printf '\033[31m%s: ЕСТЬ ПРОВАЛЫ\033[0m\n' "$1"
  exit "$RC"
}
