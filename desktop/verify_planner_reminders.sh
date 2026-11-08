#!/usr/bin/env bash
# Parvane desktop — напоминания «Плана» (ревью UI 7 ноя 2026, п. 12; как web reminders.ts и android
# PlannerReminders.kt). Событие с «Напомнить: в момент начала» на ближайшую минуту → desktop показывает штатное
# уведомление (сервисное сообщение «Parvane») и пишет отметку `Reminded` в «План»; после перезапуска то же
# напоминание не показывается снова (отметка общая для всех устройств). Без правки desktop напоминаний не
# показывал вовсе (readReminders ядра нигде не вызывался).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-reminders}"
A="$SB/alice"; AL="$A/td/log.txt"
STAMP=$(date +%s)
# начало — через 2 минуты (минутная точность «Плана»); полночь сценарий не переживает
START=$(date -d '+2 min' +%H:%M); END=$(date -d '+32 min' +%H:%M); DAY=$(date -d '+2 min' +%F)
NAME="Созвон-$STAMP"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOPLANNER=event:$NAME|$DAY|$START|$END|0@10")
wait_log "$AL" "autoplanner event $NAME → отправлено" 120 && ok "событие с напоминанием создано ($DAY $START)" || bad "событие не создано"
grep -aq "напоминание «Плана» показано: $NAME" "$AL" && bad "напомнило раньше срока" || ok "до срока не напомнило"
wait_log "$AL" "напоминание «Плана» показано: $NAME \(event\)" 220 && ok "напоминание показано в срок" || bad "напоминания нет"
wait_log "$AL" "напоминания «Плана» отмечены напомненными: 1" 30 && ok "отметка Reminded записана" || bad "отметки нет"
sleep 8 # отметка уходит на сервер пакетом
stop_pid "$AP"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOPLANNER=task:после-$STAMP@5")
wait_log "$AL" "planner: status=ready loaded=1" 120 || bad "«План» не загрузился после перезапуска"
sleep 40
N=$(grep -acE "напоминание «Плана» (показано|пропущено.*): $NAME" "$AL")
[ "$N" -eq 0 ] && ok "после перезапуска не напомнило второй раз (Reminded)" || bad "напомнило повторно ($N)"
grep -qiE "Fatal|Unexpected in " "$AL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$AP"; stack_stop
finish "НАПОМИНАНИЯ «ПЛАНА»"
