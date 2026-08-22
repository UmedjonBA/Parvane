#!/usr/bin/env bash
# Parvane desktop — ЗАПЛАНИРОВАННЫЕ сообщения: alice планирует сообщение bob'у
# через 5с (PARVANE_AUTOSCHEDULE); до срока bob НЕ получает; после — получает.
# Персист очереди в tdata/parvane-scheduled.json.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-sched}"
STAMP=$(date +%s); T="запланировано-$STAMP"
B="$SB/bob"; A="$SB/alice"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:пинг-$STAMP" PARVANE_AUTOSCHEDULE="bob@local:6:$T")
wait_log "$A/td/log.txt" "сообщение запланировано → bob@local" 40 && ok "alice запланировала сообщение" || bad "не запланировано"
# файл очереди появился
sleep 1
[ -f "$A/td/tdata/parvane-scheduled.json" ] && grep -q "$T" "$A/td/tdata/parvane-scheduled.json" && ok "очередь персистится на диск" || bad "нет файла очереди"
# до срока bob не должен получить
sleep 2
grep -q "входящее msg .* (alice@local): $T" "$B/td/log.txt" && bad "bob получил ДО срока" || ok "до срока bob не получил"
# после срока
wait_log "$A/td/log.txt" "запланированное отправлено → bob@local" 15 && ok "таймер сработал (alice отправила)" || bad "таймер не сработал"
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T" 30 && ok "bob получил после срока" || bad "bob не получил после срока"
# очередь очищена
sleep 1
if [ -s "$A/td/tdata/parvane-scheduled.json" ] && grep -q "$T" "$A/td/tdata/parvane-scheduled.json"; then bad "сообщение осталось в очереди"; else ok "очередь очищена после отправки"; fi
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "ЗАПЛАНИРОВАННЫЕ"
