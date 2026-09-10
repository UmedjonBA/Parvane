#!/usr/bin/env bash
# Уведомления кросс-девайс в форке X: alice-десктоп мутит bob (AUTOMUTE) → X (второе
# устройство alice) получает notify-блоб из sync/NotifyNotice → чат bob замучен в списке.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
. /mnt/hdd/ub/Projects/active/Parvane/desktop/verify_lib.sh
ad() { timeout 30 adb "$@"; }
OUT=/tmp/pv-tgx-notify; mkdir -p $OUT; SB=$(\ls -td /tmp/pv-tgx.* | head -1); A="$SB/alice"
APK=$(find /mnt/hdd/ub/android/tgx/app/build/outputs/apk -name "*-x64-debug.apk" | head -1)
ad install -r "$APK" >/dev/null 2>&1; ad shell am force-stop org.parvane.tgx; ad shell pm clear org.parvane.tgx >/dev/null
ad shell pm grant org.parvane.tgx android.permission.POST_NOTIFICATIONS
ad shell run-as org.parvane.tgx mkdir -p files/tdlib; ad shell run-as org.parvane.tgx cp /data/local/tmp/parvane-session.json files/tdlib/session.json
ad logcat -c; ad shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null
timeout 120 bash -c 'until adb logcat -d 2>/dev/null | grep -q "линковка: история получена"; do sleep 3; done' && ok "линковка" || bad "линковка не завершилась"
sleep 5; ad exec-out screencap -p > $OUT/01-before.png
kill $(pgrep -f "workdir $SB/alice/t[d]") 2>/dev/null; sleep 2
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 PARVANE_AUTOMUTE="bob@local:6")
wait_log "$A/td/log.txt" "automute → bob@local" 60 && ok "alice-десктоп замутила bob" || bad "automute не сработал"
timeout 60 bash -c 'until adb logcat -d 2>/dev/null | grep -q "type.*notify\|notify blob\|UpdateChatNotificationSettings"; do sleep 3; done'
sleep 8; ad exec-out screencap -p > $OUT/02-after-mute.png
ad logcat -d -v time > $OUT/logcat.txt
grep -aE "notify|мут|mute" $OUT/logcat.txt | grep -v "Notification\b" | tail -5 | cut -c1-160
echo "AndroidRuntime: $(grep -c AndroidRuntime $OUT/logcat.txt)"
echo "NOTIFY_E2E_DONE rc=$RC"
