#!/usr/bin/env bash
# Сценарий чата в форке Telegram X на уже запущенном эмуляторе со стеком и
# сессией (после tgx_session_flow.sh): bob (десктоп) пишет alice → чат в списке
# X → открыть первый чат → ответ из поля X → десктоп bob получил. Скриншоты и
# logcat в /tmp/pv-tgx-chat. Координаты для 1080×2400: первый чат (540,330),
# поле ввода (360,2208), кнопка отправки (1010,2208).
#   ./tgx_chat_flow.sh
set -u
export PATH="/home/ub/AppData/android/sdk/platform-tools:$HOME/.local/bin:$PATH"
. "$(dirname "${BASH_SOURCE[0]}")/../desktop/verify_lib.sh"
OUT=/tmp/pv-tgx-chat; mkdir -p $OUT
a() { timeout 25 adb "$@"; }  # каждая adb-команда с таймаутом
SB=$(ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s)
a logcat -c
adb logcat -v time > $OUT/logcat-live.txt 2>&1 & LCP=$!
sleep 1; a exec-out screencap -p > $OUT/00-before.png
sleep 2
a exec-out screencap -p > $OUT/00-after-allow.png
# bob → alice (перезапуск bob с autosend)
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
BP=$(start_client "$SB/bob" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:privet-$STAMP")
wait_log "$SB/bob/td/log.txt" "autosend → alice@local" 40 && echo "bob отправил" || echo "bob НЕ отправил"
sleep 8; a exec-out screencap -p > $OUT/01-list.png
. "$(dirname "${BASH_SOURCE[0]}")/tgx_ui.sh"; ui_open_chat; sleep 6; a exec-out screencap -p > $OUT/02-chat.png   # чат bob
a shell input tap 360 2208; sleep 1; a shell input text "otvet-$STAMP"; sleep 1; a exec-out screencap -p > $OUT/03-typed.png
a shell input tap 1010 2208; sleep 1; a exec-out screencap -p > $OUT/04-sent-1s.png; sleep 5; a exec-out screencap -p > $OUT/04-sent.png  # кнопка отправки (правый низ)
wait_log "$SB/bob/td/log.txt" "входящее msg .*alice@local.*otvet-$STAMP" 30 && echo "bob получил ответ из X" || echo "bob НЕ получил ответ"

# ── Ревью 7 ноя 2026, этап 2 «ежедневное сломано» (A1–A6, «без звука», пересылка копией): те же функции шва, что
# кнопки X, через e2e-хук; получатель — desktop bob
. "$(dirname "${BASH_SOURCE[0]}")/tgx_lib.sh"
TGX_LOG=$OUT/logcat-live.txt; tgx_mark
BL="$SB/bob/td/log.txt"
cnt() { grep -caE "$2" "$1" 2>/dev/null || true; }
tgx_media_files "$OUT" && ok "тестовые записи голосового, «кружка» и фото — на устройстве" || bad "тестовые записи не подготовлены"
# A1: голосовое — PreliminaryUploadFile → отправка InputFileId раньше FinishFileGeneration (порядок рекордера X)
tgx_cmd '{"op":"voice","peer":"bob@local","path":"/data/local/tmp/pv-voice.ogg","duration":2}'
tgx_logwait "голосовое → отправлено" 90 && ok "X: голосовое отправлено путём рекордера" || bad "X: голосовое не отправлено ($(grep -a 'голосовое →\|файл X' "$TGX_LOG" | tail -1 | cut -c1-160))"
wait_log "$BL" "входящее медиа [0-9a-f-]+ \(alice@local, kind=voice\)" 60 && ok "desktop: голосовое от X пришло" || bad "desktop: голосового нет"
wait_log "$BL" "получено медиа alice@local: .*\([1-9][0-9]* байт\)" 60 && ok "desktop: голосовое скачано и расшифровано" || bad "desktop: голосовое не скачано"
# A2: «кружок»
tgx_mark; N0=$(cnt "$BL" "получено медиа alice@local")
tgx_cmd '{"op":"video_note","peer":"bob@local","path":"/data/local/tmp/pv-round.mp4","duration":2}'
tgx_logwait "кружок → отправлено" 90 && ok "X: «кружок» отправлен" || bad "X: «кружок» не отправлен"
wait_log "$BL" "входящее медиа [0-9a-f-]+ \(alice@local, kind=video_note\)" 60 && ok "desktop: «кружок» от X пришёл" || bad "desktop: «кружка» нет"
for _ in $(seq 1 60); do [ "$(cnt "$BL" "получено медиа alice@local")" -gt "$N0" ] && break; sleep 1; done
[ "$(cnt "$BL" "получено медиа alice@local")" -gt "$N0" ] && ok "desktop: «кружок» скачан и расшифрован" || bad "desktop: «кружок» не скачан"
# A3: альбом из двух фото, ответ — у первого
tgx_mark; P0=$(cnt "$BL" "входящее медиа [0-9a-f-]+ \(alice@local, kind=photo\)")
tgx_cmd "{\"op\":\"album\",\"peer\":\"bob@local\",\"paths\":[\"/data/local/tmp/pv-a1.png\",\"/data/local/tmp/pv-a2.png\"],\"caption\":\"alb-$STAMP\",\"reply\":\"privet-$STAMP\"}"
tgx_logwait "альбом: отправлено 2 из 2, ответ у первого" 90 && ok "X: альбом из 2 фото отправлен (ответ у первого)" || bad "X: альбом не отправлен ($(grep -a 'альбом:' "$TGX_LOG" | tail -1 | cut -c1-120))"
for _ in $(seq 1 60); do [ "$(cnt "$BL" "входящее медиа [0-9a-f-]+ \(alice@local, kind=photo\)")" -ge $((P0 + 2)) ] && break; sleep 1; done
[ "$(cnt "$BL" "входящее медиа [0-9a-f-]+ \(alice@local, kind=photo\)")" -ge $((P0 + 2)) ] && ok "desktop: оба фото альбома пришли" || bad "desktop: фото альбома не пришли"
# A4: реакция из меню X на сообщение bob — меню не пусто, значок есть, реакция ушла
tgx_mark; tgx_cmd "{\"op\":\"react\",\"peer\":\"bob@local\",\"text\":\"privet-$STAMP\",\"emoji\":\"👍\"}"
tgx_logwait "реакции: меню 2[0-9], значок есть" 20 && ok "X: меню реакций не пусто, значок реакции есть" || bad "X: меню реакций ($(grep -a 'реакции: меню' "$TGX_LOG" | tail -1 | cut -c1-120))"
tgx_logwait "e2e-cmd react → Ok" 20 && ok "X: реакция отправлена" || bad "X: реакция не отправлена"
tgx_mark; tgx_cmd "{\"op\":\"reactions\",\"peer\":\"bob@local\",\"text\":\"privet-$STAMP\"}"
tgx_logwait "реакции сообщения: 1f44d=1 значок" 20 && ok "X: своя реакция на сообщении, значок рисуется" || bad "X: своей реакции не видно ($(grep -a 'реакции сообщения' "$TGX_LOG" | tail -1 | cut -c1-120))"
# A5: «Контакты» / «Новое сообщение» — известные собеседники с фильтром по имени/нику
tgx_mark; tgx_cmd '{"op":"contacts","query":"bo"}'
tgx_logwait "контакты: [1-9][0-9]* из [1-9][0-9]* по запросу" 20 && ok "X: контакты по запросу находятся" || bad "X: контакты пусты ($(grep -a 'контакты:' "$TGX_LOG" | tail -1 | cut -c1-80))"
tgx_mark; tgx_cmd '{"op":"contacts","query":"нетакогоника"}'
tgx_logwait "контакты: 0 из [1-9][0-9]* по запросу" 20 && ok "X: фильтр контактов отсекает чужие" || bad "X: фильтр контактов не работает"
# A6: @-подсказки группы — участники по префиксу
G="Rv-$STAMP"
tgx_mark; tgx_cmd "{\"op\":\"group_create\",\"peer\":\"bob@local\",\"members\":[\"bob@local\"],\"title\":\"$G\"}"
tgx_logwait "e2e-cmd group_create → CreatedBasicGroupChat" 30 && ok "X: группа для @-подсказок создана" || bad "X: группа не создана"
tgx_mark; tgx_cmd "{\"op\":\"members\",\"peer\":\"bob@local\",\"group\":\"$G\",\"query\":\"bo\"}"
tgx_logwait "участники: 1 из 2 по запросу" 20 && ok "X: @-подсказка нашла участника" || bad "X: @-подсказки пусты ($(grep -a 'участники:' "$TGX_LOG" | tail -1 | cut -c1-80))"
# «Отправить без звука»: Content.silent уходит, сообщение доходит
tgx_mark; tgx_cmd "{\"op\":\"send\",\"peer\":\"bob@local\",\"text\":\"tiho-$STAMP\",\"silent\":true}"
tgx_logwait "отправка без звука → чат" 20 && ok "X: отправка без звука" || bad "X: «без звука» не выставлено"
wait_log "$BL" "входящее msg .*alice@local.*tiho-$STAMP" 30 && ok "desktop: сообщение без звука пришло" || bad "desktop: сообщения без звука нет"
# Пересылка копией («Скрыть автора»): без пометки автора
tgx_mark; tgx_cmd "{\"op\":\"forward_copy\",\"peer\":\"bob@local\",\"from\":\"bob@local\",\"text\":\"privet-$STAMP\"}"
tgx_logwait "переслано 1 из 1, с пометкой автора 0" 30 && ok "X: пересылка копией — без автора" || bad "X: пересылка копией ($(grep -a 'переслано [0-9]' "$TGX_LOG" | tail -1 | cut -c1-80))"
tgx_no_crash
kill $LCP 2>/dev/null; a logcat -d -v time > $OUT/logcat.txt 2>&1
echo "=== последние строки гостя (live) ==="; grep -v "resolv\|EGL_emulation\|TrafficStats" $OUT/logcat-live.txt | tail -25 | cut -c1-170
echo "AndroidRuntime: $(grep -c AndroidRuntime $OUT/logcat.txt)"
grep -E "FATAL|AndroidRuntime.*(Exception|at org|at tgx)" $OUT/logcat.txt | head -12 | cut -c1-200
grep -oE "не реализовано: [A-Za-z]+" $OUT/logcat.txt | sort | uniq -c | sort -rn | awk '{printf "%s(%s) ", $NF, $1}'; echo
grep -E "ParvaneClient|I/parvane|E/parvane|W/parvane" $OUT/logcat.txt | grep -v "ok-заглушка\|не реализовано" | tail -12 | cut -c1-180
echo "DRIVE_DONE"
finish "TGX CHAT"
