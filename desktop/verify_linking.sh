#!/usr/bin/env bash
# Parvane desktop — АВТО-ЛИНКОВКА ИСТОРИИ между двумя desktop-экземплярами bob:
#  bob1 накопил историю (alice → bob1); свежий bob2 публикует оффер с кодом,
#  bob1 (PARVANE_AUTOLINK_GRANT=1 — подтверждение без UI) видит тот же код и
#  выдаёт грант; bob2 импортирует историю и показывает старое сообщение alice.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-link}"
STAMP=$(date +%s); T1="история-$STAMP"; T2="живое-$STAMP"
B1="$SB/bob1"; B2="$SB/bob2"; A="$SB/alice"
P1=$(start_client "$B1" bob@local PARVANE_AUTOLINK_GRANT=1)
wait_log "$B1/td/log.txt" "E2E-устройство готово" 40 || bad "bob1 не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T1")
wait_log "$B1/td/log.txt" "входящее msg .* \(alice@local\): $T1" 60 && ok "bob1 получил историю от alice" || bad "bob1 не получил"
stop_pid "$PA"

P2=$(start_client "$B2" bob@local PARVANE_AUTOLINK_GRANT=1)
wait_log "$B2/td/log.txt" "линковка: оффер опубликован, код [0-9]{6}" 40 && ok "bob2 опубликовал оффер" || bad "bob2 без оффера"
CODE2=$(grep -oE "оффер опубликован, код [0-9]{6}" "$B2/td/log.txt" | head -1 | grep -oE "[0-9]{6}")
wait_log "$B1/td/log.txt" "запрос переноса истории от устройства .*, код [0-9]{6}" 40 && ok "bob1 увидел запрос" || bad "bob1 не увидел запрос"
CODE1=$(grep -oE "запрос переноса истории от устройства [^,]*, код [0-9]{6}" "$B1/td/log.txt" | head -1 | grep -oE "[0-9]{6}$")
[ -n "$CODE2" ] && [ "$CODE1" = "$CODE2" ] && ok "SAS-коды совпадают ($CODE1)" || bad "коды: bob1=$CODE1 bob2=$CODE2"
wait_log "$B1/td/log.txt" "линковка: грант выдан" 30 && ok "грант выдан" || bad "грант не выдан"
wait_log "$B2/td/log.txt" "линковка: история получена" 40 && ok "bob2 импортировал историю" || bad "bob2 не импортировал"
wait_log "$B2/td/log.txt" "входящее msg .* \(alice@local\): $T1" 40 && ok "bob2 видит старое сообщение alice" || bad "bob2 не видит историю"
# Живое сообщение после линковки читают оба.
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T2")
wait_log "$B2/td/log.txt" "входящее msg .* \(alice@local\): $T2" 60 && ok "bob2 читает живые после линковки" || bad "bob2 не читает живые"
wait_log "$B1/td/log.txt" "входящее msg .* \(alice@local\): $T2" 30 && ok "bob1 читает живые" || bad "bob1 не читает живые"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B1/td/log.txt" "$B2/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PA"; stack_stop
finish "ЛИНКОВКА"
