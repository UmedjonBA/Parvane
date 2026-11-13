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
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:пинг-$STAMP" PARVANE_AUTOSCHEDULE="bob@local:6:$T")
wait_log "$A/td/log.txt" "сообщение запланировано → bob@local" 40 && ok "alice запланировала сообщение" || bad "не запланировано"
# файл очереди появился
sleep 1
# spec 036 T031: очередь — запись хранилища движка (tdata/parvane-host-account): что в ней запись, видно по журналу
# клиента; текста открытым на диске быть не должно
wait_log "$A/td/log.txt" "очередь отложенных записана \(1 шт\.\)" 10 && ok "очередь персистится (1 запись)" || bad "очередь не записана"
[ -d "$A/td/tdata/parvane-host-account" ] && ! grep -rqa "$T" "$A/td/tdata" --exclude='log*.txt' \
  && ok "очередь в хранилище движка (текста на диске нет)" || bad "очередь лежит на диске открытым текстом либо не в хранилище"
# до срока bob не должен получить
sleep 2
grep -q "входящее msg .* (alice@local): $T" "$B/td/log.txt" && bad "bob получил ДО срока" || ok "до срока bob не получил"
# после срока
wait_log "$A/td/log.txt" "запланированное отправлено → bob@local" 15 && ok "таймер сработал (alice отправила)" || bad "таймер не сработал"
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T" 30 && ok "bob получил после срока" || bad "bob не получил после срока"
# очередь очищена
sleep 1
grep -a "очередь отложенных записана" "$A/td/log.txt" | tail -1 | grep -q "(0 шт.)" && ok "очередь очищена после отправки" \
  || bad "сообщение осталось в очереди"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "ЗАПЛАНИРОВАННЫЕ"
