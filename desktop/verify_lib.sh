#!/usr/bin/env bash
# Parvane — общая обвязка desktop-e2e (мультидевайс/линковка/devices/email/edit).
# Поднимает nats + шарды (identity, messenger, cloud, call) + gateway в $SB,
# даёт ok/bad/start_client/wait_log/stop_all. Источник: . verify_lib.sh
# ВАЖНО: бинарь tdesktop должен быть собран с -DPARVANE_DEV=ON — иначе
# PARVANE_AUTOLOGIN/AUTOSEND/PARVANE_GATEWAY_URL=host:port игнорируются (P-45/P-46).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_paths.sh"
RC=0
# ── протокол клиентов сценария (T135) ────────────────────────────────────────
# v2 включён по умолчанию; PV_PROTO=v1 — весь сценарий на прежнем протоколе
# (клиентам уходит PARVANE_PROTO_V2=0). Проверки, привязанные к v1 (ответы
# шарда group.*, таблицы messenger.db, каталог устройств v1), идут только при
# PV_PROTO=v1; для v2 рядом стоят проверки по журналам клиентов и БД v2.
PV_PROTO="${PV_PROTO:-v2}"
if [ "$PV_PROTO" = v1 ]; then export PARVANE_PROTO_V2=0; else export PARVANE_PROTO_V2=1; fi
is_v2() { [ "$PV_PROTO" != v1 ]; }
# Адрес группы по имени из лога создателя: UUID (v1) либо v2g:<hex> (v2).
group_gid() { # group_gid <log> <имя>
  grep -a "группа \(v2 \)\?'$2' создана" "$1" 2>/dev/null \
    | grep -oE 'v2g:[0-9a-f]{32}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}' | head -1
}
# Последняя строка «группа <gid> обновлена (…)» в логе клиента: версия, права,
# роль самого клиента, заявки и админы — состояние группы глазами участника.
group_line() { # group_line <log> <gid>
  grep -a "Parvane: группа $2 обновлена" "$1" 2>/dev/null | tail -1
}
# Окружение устройств одного аккаунта. v2: второе устройство обязано быть
# привязано (LINK-1 v2) — старое выдаёт грант без UI (PARVANE_AUTOLINK_GRANT=1),
# новое публикует оффер само. v1: второе устройство работает и без линковки —
# офферы выключены, как в сценариях до v2.
if is_v2; then PV_DEV_OLD=(PARVANE_AUTOLINK_GRANT=1); PV_DEV_NEW=(PARVANE_AUTOLINK_GRANT=1)
else PV_DEV_OLD=(PARVANE_NO_LINK_OFFER=1); PV_DEV_NEW=(PARVANE_NO_LINK_OFFER=1); fi
wait_linked() { # wait_linked <log нового устройства> [сек=90]
  wait_log "$1" "v2: устройство привязано грантом линковки" "${2:-90}" && wait_log "$1" "v2: готов" 60
}
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
PIDS=()
# Гасит ТОЛЬКО стек desktop-e2e: nats на 4222 и шарды, подключённые к нему.
# Не по имени процесса (`pkill -x identity`) — рядом могут идти web-e2e со своими
# шардами из тех же бинарей на других портах.
stack_pids() { # stack_pids <имя-шарда|все>
  local p names="${1:-identity|messenger|cloud|call|gateway|preview|push|domains}"
  for p in $(pgrep -x "$names" 2>/dev/null); do
    tr '\0' '\n' <"/proc/$p/environ" 2>/dev/null \
      | grep -qx 'PARVANE_NATS_URL=nats://127.0.0.1:4222' && echo "$p"
  done
}
stack_reap() {
  local p
  for p in $(stack_pids); do kill "$p" 2>/dev/null; done
  for p in $(pgrep -x nats-server 2>/dev/null); do
    tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- '-p 4222 ' && kill "$p" 2>/dev/null
  done
  for _ in $(seq 1 25); do
    (exec 3<>/dev/tcp/127.0.0.1/4222) 2>/dev/null || return 0
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
# stack_up <scratch> [env-для-identity] — поднять стек, НЕ очищая каталог
# (скрипт уже разложил в нём профили/файлы); stack_start — то же с очисткой.
stack_up() {
  SB="$1"; shift
  mkdir -p "$SB"
  [ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
  for s in identity messenger cloud call gateway; do
    [ -x "$SHARD/$s" ] || { echo "нет шарда $SHARD/$s — cargo build"; exit 2; }
  done
  command -v nats-server >/dev/null || { echo "нет nats-server в PATH"; exit 2; }
  stack_reap   # хвост прошлого прогона на тех же портах
  nats-server -p 4222 >"$SB/nats.log" 2>&1 & PIDS+=($!)
  wait_port 4222 || { echo "nats-server не поднялся (см. $SB/nats.log)"; exit 2; }
  # headless-клиенты перелогиниваются ~1-2 раза/с с 127.0.0.1 — лимиты по IP
  # и логину (identity) для e2e снимаем, иначе через ~15 с интро замирает
  env PARVANE_LOGIN_RATE=100000 PARVANE_LOGIN_RATE_IP=100000 \
    PARVANE_REGISTER_RATE=100000 PARVANE_REGISTER_RATE_IP=100000 PARVANE_REGISTER_RATE_GLOBAL=100000 \
    "$@" PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/identity.db" \
    PARVANE_LOG_LEVEL=info "$SHARD/identity" >"$SB/identity.log" 2>&1 & PIDS+=($!)
  # domains (каркас доменов, spec 010) — если собран: desktop его не использует,
  # но стек должен совпадать с web-e2e и продом
  for s in messenger cloud call domains; do
    [ "$s" = domains ] && [ ! -x "$SHARD/$s" ] && continue
    PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" \
      PARVANE_LOG_LEVEL=info "$SHARD/$s" >"$SB/$s.log" 2>&1 & PIDS+=($!)
  done
  gateway_start
  wait_port 9223
  sleep 2
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
# PV_V1_OFF=1 — любой сценарий на сервере с отключённым v1 (E6-1, T178): gateway в
# режиме PARVANE_V1_MODE=disabled, если сценарий сам режим не задал и идёт по v2;
# `finish` сверяет, что по v1 не авторизовался никто.
v1_off() { [ "${PV_V1_OFF:-0}" = 1 ] && is_v2; }
gateway_start() {
  local v1mode=""
  if v1_off; then case " ${PV_GATEWAY_ENV:-} " in *PARVANE_V1_MODE=*) ;; *) v1mode="PARVANE_V1_MODE=disabled" ;; esac; fi
  # shellcheck disable=SC2086
  env ${PV_GATEWAY_ENV:-} $v1mode PARVANE_NATS_URL=nats://127.0.0.1:4222 \
    PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 \
    PARVANE_LOG_LEVEL=info "$SHARD/gateway" >>"$SB/gateway.log" 2>&1 & GW_PID=$!
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
# Пароль тестовых аккаунтов: сервер требует не короче 8 символов (P-43),
# прежний «test» больше не регистрируется.
PV_PASSWORD="${PV_PASSWORD:-test-pass-2026}"
# start_client <workdir> <user@server> [ENV=VAL ...] → pid; лог: <workdir>/td/log.txt
start_client() {
  local work="$1" user="$2"; shift 2
  mkdir -p "$work/td"
  # tdesktop переписывает log.txt при каждом старте — прошлый прогон сохраняем
  [ -f "$work/td/log.txt" ] && mv "$work/td/log.txt" "$work/td/log.$(date +%s%N).txt"
  # ENV из аргументов — после умолчаний: вызывающий может их переопределить
  # (например PARVANE_GATEWAY_URL=ws://127.0.0.1:9222/ws для WebSocket)
  env QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
    PARVANE_AUTOLOGIN="$user:$PV_PASSWORD" "$@" "$BIN" -workdir "$work/td" \
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
  if v1_off && [ -n "${SB:-}" ] && [ -f "$SB/gateway.log" ]; then
    grep -qa "v1-путь в режиме Disabled" "$SB/gateway.log" && ok "E6-1: gateway с отключённым v1" \
      || echo "E6-1: gateway режим не отметил (сценарий без соединений v1 либо свой режим)"
    grep -qa "gateway::session.*Клиент авторизован" "$SB/gateway.log" && bad "E6-1: кто-то авторизовался по v1" \
      || ok "E6-1: по v1 не авторизовался никто"
  fi
  [ "$RC" -eq 0 ] && printf '\033[32m%s: OK\033[0m\n' "$1" || printf '\033[31m%s: ЕСТЬ ПРОВАЛЫ\033[0m\n' "$1"
  exit "$RC"
}
