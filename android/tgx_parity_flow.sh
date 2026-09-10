#!/usr/bin/env bash
# Паритет в форке X на уже поднятых стеке/эмуляторе/сессии (после tgx_link_flow.sh):
# переустановка APK → повторная линковка → bob пишет → чат → presence («online») →
# ответ из X. Скрины и logcat в /tmp/pv-tgx-parity.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
. "$(dirname "${BASH_SOURCE[0]}")/../desktop/verify_lib.sh"
ad() { timeout 30 adb "$@"; }
OUT=/tmp/pv-tgx-parity; mkdir -p $OUT; SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s)
APK=$(find /mnt/hdd/ub/android/tgx/app/build/outputs/apk -name "*-x64-debug.apk" | head -1)
ad install -r "$APK" >/dev/null 2>&1 && ok "APK установлен" || bad "APK не установился"
ad shell am force-stop org.parvane.tgx; ad shell pm clear org.parvane.tgx >/dev/null
ad shell pm grant org.parvane.tgx android.permission.POST_NOTIFICATIONS
ad shell run-as org.parvane.tgx mkdir -p files/tdlib
ad shell run-as org.parvane.tgx cp /data/local/tmp/parvane-session.json files/tdlib/session.json
ad logcat -c; adb logcat -v time > $OUT/logcat-live.txt 2>&1 & LCP=$!
ad shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null
timeout 120 bash -c 'until adb logcat -d 2>/dev/null | grep -q "линковка: история получена"; do sleep 3; done' && ok "линковка: история импортирована" || bad "линковка не завершилась"
sleep 6; ad exec-out screencap -p > $OUT/01-list.png
# bob пишет → чат вверху; открываем
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
BP=$(start_client "$SB/bob" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:hello-$STAMP")
wait_log "$SB/bob/td/log.txt" "autosend → alice@local" 40 && ok "bob отправил" || bad "bob не отправил"
timeout 60 bash -c "until adb logcat -d 2>/dev/null | grep -q 'hello-$STAMP'; do sleep 2; done" && ok "X получил hello" || bad "X не получил hello"
sleep 3; ad shell input tap 540 330; sleep 5; ad exec-out screencap -p > $OUT/02-chat.png
# presence: bob-десктоп шлёт хартбит каждые 30 с → в шапке чата «online»
sleep 35; ad exec-out screencap -p > $OUT/03-chat-presence.png
# ответ из X
ad shell input tap 360 2208; sleep 1; ad shell input text "reply-$STAMP"; sleep 1; ad shell input tap 1010 2208; sleep 5
wait_log "$SB/bob/td/log.txt" "входящее msg .*alice@local.*reply-$STAMP" 30 && ok "bob получил ответ из X" || bad "bob не получил ответ"
ad exec-out screencap -p > $OUT/04-sent.png
kill $LCP 2>/dev/null; ad logcat -d -v time > $OUT/logcat.txt
echo "AndroidRuntime: $(grep -c AndroidRuntime $OUT/logcat.txt)"
grep -aE "FATAL|AndroidRuntime.*(Exception|at org|at tgx)" $OUT/logcat.txt | head -8 | cut -c1-200
grep -aE "I/parvane|E/parvane|E/ParvaneClient" $OUT/logcat.txt | grep -v "ok-заглушка" | tail -8 | cut -c1-170
grep -oE "не реализовано: [A-Za-z]+" $OUT/logcat.txt | sort | uniq -c | sort -rn | awk '{printf "%s(%s) ", $NF, $1}'; echo
echo "PARITY_DONE rc=$RC"
