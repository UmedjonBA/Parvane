#!/usr/bin/env bash
# Parvane desktop — АВТО-ЛИНКОВКА ИСТОРИИ между двумя desktop-экземплярами bob:
#  bob1 накопил историю (alice → bob1); свежий bob2 публикует оффер-обязательство
#  (LINK-1), bob1 (PARVANE_AUTOLINK_GRANT=1 — подтверждение без UI) отвечает
#  challenge, после раскрытия ключа видит тот же код сверки и выдаёт грант;
#  bob2 импортирует историю и показывает старое сообщение alice.
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
# LINK-1: оффер — обязательство на эфемерный ключ (без ключа и без кода); старое
# устройство шлёт challenge, новое раскрывает ключ, и только тогда обе стороны
# считают SAS (12 цифр) от ПАРЫ ключей. Код в лог пишет только dev-сборка.
wait_log "$B2/td/log.txt" "линковка: оффер \(обязательство\) опубликован" 40 && ok "bob2 опубликовал оффер (обязательство)" || bad "bob2 без оффера"
SAS_RE='[0-9]{4} [0-9]{4} [0-9]{4}'   # 12 цифр группами по 4
wait_log "$B2/td/log.txt" "линковка \(dev\): код сверки $SAS_RE\$" 60 && ok "bob2 получил challenge, раскрыл ключ, код 12 цифр" || bad "bob2 не дошёл до кода сверки"
CODE2=$(grep -oE "линковка \(dev\): код сверки $SAS_RE\$" "$B2/td/log.txt" | head -1 | grep -oE "$SAS_RE\$")
wait_log "$B1/td/log.txt" "запрос переноса истории от устройства .*, код готов" 40 && ok "bob1 увидел запрос" || bad "bob1 не увидел запрос"
# код на СТАРОМ устройстве dev-сборка пишет отдельной строкой (сверка SAS между устройствами)
CODE1=$(grep -oE "линковка \(dev\): код сверки $SAS_RE для устройства" "$B1/td/log.txt" | head -1 | grep -oE "$SAS_RE")
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
