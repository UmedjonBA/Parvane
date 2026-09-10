#!/usr/bin/env bash
# Группы + медиа-приём в форке X: alice-десктоп создаёт группу с bob (AUTOGROUP), bob пишет в
# группу (AUTOSEND=<gid>:…) и шлёт alice фото (AUTOSENDFILE), X (второе устройство alice)
# после линковки видит группу, сообщение в ней и фото; отвечает в группу → bob получил.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
. "$(dirname "${BASH_SOURCE[0]}")/../desktop/verify_lib.sh"
ad() { timeout 30 adb "$@"; }
OUT=/tmp/pv-tgx-group; mkdir -p $OUT; SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s); GNAME="pvgroup-$STAMP"
A="$SB/alice"; B="$SB/bob"
kill $(pgrep -f "workdir $SB/alice/t[d]") 2>/dev/null; sleep 2
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 PARVANE_AUTOGROUP="$GNAME:bob@local")
wait_log "$A/td/log.txt" "группа '$GNAME' создана" 60 && ok "alice создала группу" || bad "группа не создана"
GID=$(grep -a "группа '$GNAME' создана" "$A/td/log.txt" | grep -oE '[0-9a-f-]{36}' | head -1); echo "GID=$GID"
# bob: прогрев (синк групп), затем перезапуск с хуками — AUTOSEND умеет только 1-на-1,
# в группу умеет AUTOSENDFILE (фото); хук срабатывает раньше первого синка групп,
# поэтому нужен второй запуск, когда группа уже в g_knownGroups с прошлого раза
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "групп синхронизировано: [1-9]" 60 && ok "bob знает группу" || bad "bob не синхронизировал группы"
sleep 2; stop_pid "$BP"; sleep 1
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:grp-hello-$STAMP" PARVANE_AUTOSENDFILE="$GID:/tmp/pv-test.jpg")
wait_log "$B/td/log.txt" "медиа отправлено msg .*→ $GID" 60 && ok "bob отправил фото в группу" || bad "bob не отправил фото в группу"
PHOTO=$(grep -a "медиа отправлено msg .*→ $GID" "$B/td/log.txt" | grep -oE 'msg [0-9a-f-]{36}' | head -1 | cut -c5-); echo "PHOTO=$PHOTO"
wait_log "$A/td/log.txt" "$PHOTO" 60 && ok "alice-десктоп получила фото из группы" || bad "alice не получила фото из группы"
# X: чистая установка + сессия → линковка → группы
APK=$(find /mnt/hdd/ub/android/tgx/app/build/outputs/apk -name "*-x64-debug.apk" | head -1)
ad install -r "$APK" >/dev/null 2>&1; ad shell am force-stop org.parvane.tgx; ad shell pm clear org.parvane.tgx >/dev/null
ad shell pm grant org.parvane.tgx android.permission.POST_NOTIFICATIONS
ad shell run-as org.parvane.tgx mkdir -p files/tdlib; ad shell run-as org.parvane.tgx cp /data/local/tmp/parvane-session.json files/tdlib/session.json
ad logcat -c; ad shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null
timeout 120 bash -c 'until adb logcat -d 2>/dev/null | grep -q "линковка: история получена"; do sleep 3; done' && ok "линковка" || bad "линковка не завершилась"
timeout 60 bash -c 'until adb logcat -d 2>/dev/null | grep -q "групп синхронизировано: [1-9]"; do sleep 3; done' && ok "X: группы синхронизированы" || bad "X: групп нет"
timeout 90 bash -c "until adb logcat -d 2>/dev/null | grep -q 'grp-hello-$STAMP'; do sleep 3; done" && ok "X: текст bob принят" || bad "X: текст bob не принят"
timeout 90 bash -c "until adb logcat -d 2>/dev/null | grep -q 'входящее msg $PHOTO'; do sleep 3; done" && ok "X: фото bob в группу расшифровано" || bad "X: фото в группу не расшифровано"
sleep 5; ad exec-out screencap -p > $OUT/01-list.png
ad shell input tap 540 330; sleep 5; ad exec-out screencap -p > $OUT/02-first-chat.png
ad shell input tap 360 2208; sleep 1; ad shell input text "grp-reply-$STAMP"; sleep 1; ad shell input tap 1010 2208; sleep 6
ad exec-out screencap -p > $OUT/03-after-send.png
wait_log "$B/td/log.txt" "grp-reply-$STAMP" 40 && ok "bob получил ответ из X (группа или 1-на-1 — см. скрин)" || bad "bob не получил ответ из X"
ad shell input keyevent 4; sleep 2; ad shell input tap 540 470; sleep 6; ad exec-out screencap -p > $OUT/04-second-chat.png
ad logcat -d -v time > $OUT/logcat.txt
echo "AndroidRuntime: $(grep -c AndroidRuntime $OUT/logcat.txt)"; grep -aE "FATAL|AndroidRuntime.*(Exception|at org|at tgx)" $OUT/logcat.txt | head -6 | cut -c1-200
grep -aE "I/parvane|E/parvane|E/ParvaneClient|W/ParvaneClient" $OUT/logcat.txt | grep -v "ok-заглушка\|присутствие" | tail -12 | cut -c1-170
grep -oE "не реализовано: [A-Za-z]+" $OUT/logcat.txt | sort | uniq -c | sort -rn | awk '{printf "%s(%s) ", $NF, $1}'; echo
echo "GROUP_E2E_DONE rc=$RC"
