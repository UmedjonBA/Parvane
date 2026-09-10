#!/usr/bin/env bash
# Сценарий чата в форке Telegram X на уже запущенном эмуляторе со стеком и
# сессией (после tgx_session_flow.sh): bob (десктоп) пишет alice → чат в списке
# X → открыть первый чат → ответ из поля X → десктоп bob получил. Скриншоты и
# logcat в /tmp/pv-tgx-chat. Координаты для 1080×2400: первый чат (540,330),
# поле ввода (360,2208), кнопка отправки (1010,2208).
#   ./tgx_chat_flow.sh
set -u
export PATH="/mnt/hdd/ub/android/sdk/platform-tools:$HOME/.local/bin:$PATH"
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
a shell input tap 540 330; sleep 6; a exec-out screencap -p > $OUT/02-chat.png   # первый чат в списке
a shell input tap 360 2208; sleep 1; a shell input text "otvet-$STAMP"; sleep 1; a exec-out screencap -p > $OUT/03-typed.png
a shell input tap 1010 2208; sleep 1; a exec-out screencap -p > $OUT/04-sent-1s.png; sleep 5; a exec-out screencap -p > $OUT/04-sent.png  # кнопка отправки (правый низ)
wait_log "$SB/bob/td/log.txt" "входящее msg .*alice@local.*otvet-$STAMP" 30 && echo "bob получил ответ из X" || echo "bob НЕ получил ответ"
kill $LCP 2>/dev/null; a logcat -d -v time > $OUT/logcat.txt 2>&1
echo "=== последние строки гостя (live) ==="; grep -v "resolv\|EGL_emulation\|TrafficStats" $OUT/logcat-live.txt | tail -25 | cut -c1-170
echo "AndroidRuntime: $(grep -c AndroidRuntime $OUT/logcat.txt)"
grep -E "FATAL|AndroidRuntime.*(Exception|at org|at tgx)" $OUT/logcat.txt | head -12 | cut -c1-200
grep -oE "не реализовано: [A-Za-z]+" $OUT/logcat.txt | sort | uniq -c | sort -rn | awk '{printf "%s(%s) ", $NF, $1}'; echo
grep -E "ParvaneClient|I/parvane|E/parvane|W/parvane" $OUT/logcat.txt | grep -v "ok-заглушка\|не реализовано" | tail -12 | cut -c1-180
echo "DRIVE_DONE"
