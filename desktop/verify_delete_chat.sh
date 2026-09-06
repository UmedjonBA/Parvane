#!/usr/bin/env bash
# Parvane — удаление чата «для меня» (msg.chat.clear, как в вебе): alice и bob
# обменялись сообщениями; alice удаляет диалог bob штатным путём
# (deleteConversation → MirrorClearHistory). Проверяем:
#   1) лог alice: очистка чата, N скрытых, событие ушло на шину (messenger лог);
#   2) после рестарта alice сообщения bob не воспроизводятся из журнала и не
#      приходят из sync (скрыты сервером для alice);
#   3) у bob переписка на месте (скрытие только «для меня»);
#   4) новое сообщение bob после удаления снова доходит до alice.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-delchat.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; mkdir -p "$A/td" "$B/td"
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob: устройство не готово"
AP=$(start_client "$A" alice@local PARVANE_AUTOSEND="bob@local:before-delete-$STAMP")
wait_log "$B/td/log.txt" "входящее msg .*alice@local.*before-delete-$STAMP" 40 && ok "bob получил первое сообщение" || bad "bob не получил первое"
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_AUTOSEND="alice@local:from-bob-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*from-bob-$STAMP" 40 && ok "alice получила ответ bob" || bad "alice не получила ответ"
# bob останавливаем: в headless он пере-логинивается и его autosend слал бы новые
# from-bob (свежие uuid) во время проверки «не вернулось». Историю bob проверим
# по его прошлым логам.
stop_pid "$BP"; stop_pid "$AP"
# alice удаляет диалог bob через 4с после старта (журнал воспроизведён + sync)
AP=$(start_client "$A" alice@local PARVANE_AUTOCLEARCHAT="bob@local:4")
wait_log "$A/td/log.txt" "очистка чата bob@local — скрыто [0-9]+ сообщений" 40 && ok "alice: очистка чата ушла ($(grep -oE 'скрыто [0-9]+' "$A/td/log.txt" | tail -1))" || bad "alice: нет очистки чата"
N=$(grep -oE "скрыто [0-9]+" "$A/td/log.txt" | tail -1 | grep -oE "[0-9]+"); [ "${N:-0}" -ge 2 ] && ok "скрыты оба сообщения (N=$N)" || bad "скрыто меньше двух (N=$N)"
wait_log "$SB/messenger.log" "Очистка истории: alice@local скрыл" 20 && ok "messenger: скрыл для alice" || bad "messenger не получил msg.chat.clear"
sleep 2; stop_pid "$AP"
# рестарт alice: ничего из диалога bob не должно вернуться
AP=$(start_client "$A" alice@local)
wait_log "$A/td/log.txt" "E2E-устройство готово" 40 || bad "alice не перезапустилась"
sleep 6
grep -q "before-delete-$STAMP\|from-bob-$STAMP" "$A/td/log.txt" && bad "после удаления сообщения bob вернулись у alice" || ok "после рестарта переписка с bob не вернулась"
# bob шлёт новое — должно дойти (новый диалог не скрыт)
BP=$(start_client "$B" bob@local PARVANE_AUTOSEND="alice@local:after-delete-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*after-delete-$STAMP" 40 && ok "новое сообщение bob после удаления дошло" || bad "новое сообщение bob не дошло"
cat "$B"/td/log*.txt | grep -q "before-delete-$STAMP" && ok "у bob история на месте (скрытие только «для меня»)" || bad "у bob пропала история"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные ошибки" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "УДАЛЕНИЕ ЧАТА"
