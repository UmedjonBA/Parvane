#!/usr/bin/env bash
# Протокол v2 (spec 007, T150; правило STATE-2): правка личного состояния, сделанная
# без подключённого журнала (до подъёма v2, без связи) либо не успевшая в журнал
# до выхода, не затирается снимком с сервера — устройство досылает её в журнал до
# проекции. И обратное: устройство, которое ничего не правило, чужую правку,
# сделанную в его отсутствие, принимает, а не откатывает своим старым состоянием.
# alice1 и alice2 (привязано грантом) — на v2, bob — собеседник на v2.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-state-dirty"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"

# ── переписка: у alice появляется чат с bob (его можно закрепить) ─────────────
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOSEND_V2=bob@local:знакомство-$S")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова" || bad "alice1: v2 не поднялся"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): знакомство-$S" 60 || bad "bob не получил текст alice1"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:ответ-$S")
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): ответ-$S" 90 && ok "alice1 получила ответ bob" \
  || bad "alice1 не получила ответ bob"

# ── второе устройство alice ──────────────────────────────────────────────────
P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1)
wait_linked "$L2" 150 && ok "alice2 привязана грантом" || bad "alice2 не привязана"
wait_log "$L2" "журнал личного состояния подключён" 90 && ok "alice2: журнал состояния подключён" \
  || bad "alice2: журнал состояния не подключён"
wait_log "$L2" "своё msg [0-9a-f-]+ \(bob@local\): знакомство-$S" 60 || bad "alice2: истории нет (чата с bob не будет)"
sleep 3

# ── правка без журнала: alice2 запущена без связи с сервером (журнал не подключён),
#    чат закреплён и клиент закрыт — правка осталась только на диске ─────────────
stop_pid "$P2"
P2=$(start_client "$A2" alice@local PARVANE_GATEWAY_URL=127.0.0.1:9 "PARVANE_AUTOSTATE=pin:bob@local@4")
wait_log "$L2" "autostate pin → bob@local" 40 && ok "alice2 (без связи): чат с bob закреплён" \
  || bad "alice2: закреп не сработал"
sleep 2
grep -qa "журнал личного состояния подключён" "$L2" && bad "alice2: журнал подключён — сценарий не проверяет T150" \
  || ok "правка сделана без журнала состояния"
stop_pid "$P2"
# обычный запуск: снимок журнала (закрепа в нём нет) не должен затереть правку
P2=$(start_client "$A2" alice@local)
wait_log "$L2" "журнал личного состояния подключён" 90 || bad "alice2: журнал состояния не подключён после рестарта"
wait_log "$L2" "несохранённая правка личного состояния дослана в журнал \(pinned\)" 30 \
  && ok "alice2: несохранённая правка дослана в журнал до проекции" || bad "alice2: правка не дослана"
wait_log "$L1" "журнал состояния → архив 0, закреплено 1" 15 && ok "alice1: закреп alice2 пришёл из журнала" \
  || bad "alice1: закреп alice2 не пришёл — правку затёр снимок"
grep -qa "журнал состояния → архив 0, закреплено 0" "$L2" && bad "alice2: проекция сняла свой закреп" \
  || ok "alice2: проекция свой закреп не сняла"

# ── устройство без своих правок принимает чужую, сделанную в его отсутствие ───
stop_pid "$P2"
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOSTATE=archive:bob@local@15")
wait_log "$L1" "autostate archive → bob@local" 60 && ok "alice1: чат с bob убран в архив (alice2 выключена)" \
  || bad "alice1: архив не сработал"
sleep 4
P2=$(start_client "$A2" alice@local)
wait_log "$L2" "журнал личного состояния подключён" 90 || bad "alice2: журнал состояния не подключён"
wait_log "$L2" "журнал состояния → архив 1, закреплено 0" 20 && ok "alice2: приняла архив, сделанный в её отсутствие" \
  || bad "alice2: архив из журнала не применён"
grep -qa "несохранённая правка личного состояния" "$L2" && bad "alice2: ложная «несохранённая правка» — откат чужой правки" \
  || ok "alice2: своих правок не было — в журнал ничего не дослано"
sleep 10
grep -qa "журнал состояния → архив 0" "$L1" && bad "alice1: архив откатан вернувшимся устройством" \
  || ok "alice1: архив на месте после возвращения alice2"

grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_state_dirty"
