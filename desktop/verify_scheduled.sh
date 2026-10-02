#!/usr/bin/env bash
# Parvane desktop — ЗАПЛАНИРОВАННЫЕ сообщения: alice планирует сообщение bob'у
# через 5с (PARVANE_AUTOSCHEDULE); до срока bob НЕ получает; после — получает.
# Персист очереди в tdata/parvane-scheduled.json (зашифрован, P-13).
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
# P-13: файл очереди зашифрован (PVSE1) — текста в нём быть не должно; что в очереди
# есть запись, видно по размеру (после отправки файл сжимается до пустого списка)
QF="$A/td/tdata/parvane-scheduled.json"
S1=$(stat -c%s "$QF" 2>/dev/null || echo 0)
[ "$S1" -gt 0 ] && ok "очередь персистится на диск ($S1 байт)" || bad "нет файла очереди"
head -c 5 "$QF" 2>/dev/null | grep -q '^PVSE1' && ! grep -qa "$T" "$QF" && ok "файл очереди зашифрован (текста на диске нет)" || bad "очередь лежит на диске открытым текстом"
# до срока bob не должен получить
sleep 2
grep -q "входящее msg .* (alice@local): $T" "$B/td/log.txt" && bad "bob получил ДО срока" || ok "до срока bob не получил"
# после срока
wait_log "$A/td/log.txt" "запланированное отправлено → bob@local" 15 && ok "таймер сработал (alice отправила)" || bad "таймер не сработал"
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T" 30 && ok "bob получил после срока" || bad "bob не получил после срока"
# очередь очищена
sleep 1
S2=$(stat -c%s "$QF" 2>/dev/null || echo 0)
[ "$S2" -lt "$S1" ] && ok "очередь очищена после отправки ($S1 → $S2 байт)" || bad "сообщение осталось в очереди ($S1 → $S2 байт)"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "ЗАПЛАНИРОВАННЫЕ"
