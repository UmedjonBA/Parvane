#!/usr/bin/env bash
# Parvane desktop — раздел «Запланированные» (ревью UI 7 ноя 2026, п. 6, 7, 13). Действия — хуком PARVANE_AUTOUI,
# через штатные пути tdesktop: ApiWrap::sendMessage / sendFile / sendVoiceMessage / Api::SendLocation с
# options.scheduled, Data::ScheduledMessages (список раздела), Data::Histories::deleteMessages (удалить),
# «Отправить сейчас», Api::RescheduleMessage (перенести). Без правок: файл, голосовое и геопозиция уходили сразу,
# раздел был пуст (messages.getScheduledHistory), удалить/перенести было нельзя, далёкий срок (> 23 дней)
# срабатывал раньше времени.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-sched-ui}"
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"
STAMP=$(date +%s)
PNG="$SB/p.png"; OGG="$SB/v.ogg"
base64 -d > "$PNG" <<'B64'
iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DwHwyBFAAAdDwF/dyJPjQAAAAASUVORK5CYII=
B64
head -c 3000 /dev/urandom > "$OGG"

pair_exchange "$A" alice@local "$B" bob@local
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOUI=schedtext:bob@local|сейчас-$STAMP|3600@3,schedfile:bob@local|$PNG|3700@4,schedfile:bob@local|$OGG|3800|voice@5,schedloc:bob@local|55.75|37.61|3900@6,schedtext:bob@local|далёкое-$STAMP|3000000@7,schedlist:bob@local@10,schednow:bob@local@12,schedlist:bob@local@16,scheddelete:bob@local@18,schedlist:bob@local@21,schedmove:bob@local|4@23,schedlist:bob@local@32")

wait_log "$AL" "сообщение запланировано → bob@local .*\(file\)" 30 && ok "фото запланировано, а не отправлено" || bad "фото не запланировано"
sleep 3
grep -ac "сообщение запланировано → bob@local .*(file)" "$AL" | grep -q '^2$' && ok "голосовое запланировано" || bad "голосовое не запланировано"
wait_log "$AL" "сообщение запланировано → bob@local .*\(content\)" 20 && ok "геопозиция запланирована" || bad "геопозиция не запланирована"
sleep 2
grep -aqE "входящее медиа .*alice@local|alice@local\): сейчас-$STAMP" "$BL" && bad "что-то ушло до срока" || ok "до срока bob ничего не получил"
wait_log "$AL" "autoui запланированные bob@local: 5 " 30 && ok "раздел «Запланированные»: 5" || bad "раздел пуст ($(grep -a 'autoui запланированные' "$AL" | tail -1))"
# «Отправить сейчас» — первое по сроку (текст)
wait_log "$AL" "«Отправить сейчас» отложенного → bob@local" 30 && ok "«Отправить сейчас»" || bad "«Отправить сейчас» не сработало"
wait_log "$BL" "входящее msg .* \(alice@local\): сейчас-$STAMP" 40 && ok "bob получил «сейчас»" || bad "bob не получил «сейчас»"
wait_log "$AL" "autoui запланированные bob@local: 4 " 20 && ok "после отправки — 4" || bad "после отправки не 4"
# «Удалить» — фото
wait_log "$AL" "удалено запланированных 1" 20 && ok "«Удалить» из раздела" || bad "удаление не сработало"
wait_log "$AL" "autoui запланированные bob@local: 3 " 20 && ok "после удаления — 3" || bad "после удаления не 3"
# «Перенести» — голосовое на +4 с, уходит само
wait_log "$AL" "отложенное изменено → bob@local" 20 && ok "«Перенести»" || bad "перенос не сработал"
wait_log "$AL" "запланированное отправлено → bob@local \(файл" 30 && ok "перенесённое голосовое ушло в новый срок" || bad "перенесённое не ушло"
wait_log "$BL" "входящее медиа .*alice@local.*kind=voice" 60 && ok "bob получил голосовое" || bad "bob не получил голосовое"
wait_log "$AL" "autoui запланированные bob@local: 2 " 20 && ok "осталось 2 (геопозиция и далёкое)" || bad "осталось не 2"
grep -aq "alice@local): далёкое-$STAMP" "$BL" && bad "далёкое ушло раньше срока" || ok "далёкое (35 дней) ждёт"
stop_pid "$AP"
# переживает перезапуск: файловая и далёкая — на диске (зашифрованы)
QF="$A/td/tdata/parvane-scheduled.json"
head -c 5 "$QF" | grep -q '^PVSE1' && ! grep -qa "далёкое-$STAMP" "$QF" && ok "очередь на диске зашифрована" || bad "очередь открытым текстом"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOUI=schedlist:bob@local@5,schedonline:bob@local|в-сети-$STAMP@7")
wait_log "$AL" "autoui запланированные bob@local: 2 " 40 && ok "после перезапуска — 2" || bad "очередь потерялась при перезапуске"
# п. 13 — «Отправить, когда будет в сети»: bob в сети — уходит сразу, а не через 23 дня
wait_log "$AL" "сообщение запланировано → bob@local на «когда будет в сети»" 30 && ok "«когда будет в сети» в очереди" || bad "«когда будет в сети» не запланировано"
wait_log "$BL" "входящее msg .* \(alice@local\): в-сети-$STAMP" 60 && ok "bob в сети — получил" || bad "«когда будет в сети» не ушло"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stack_stop
finish "РАЗДЕЛ «ЗАПЛАНИРОВАННЫЕ»"
