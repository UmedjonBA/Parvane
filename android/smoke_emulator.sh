#!/usr/bin/env bash
# Parvane Android — дымовой тест в эмуляторе x86_64 против ЛОКАЛЬНОГО стека
# (шарды из desktop/verify_lib.sh; gateway WS 127.0.0.1:9222 = 10.0.2.2 в эмуляторе):
#   1) bob и alice регистрируются headless-десктопом (PARVANE_AUTOLOGIN);
#   2) приложение (extras autologin/autosend) входит как alice и пишет bob;
#   3) bob (десктоп) получает; bob пишет alice — приложение получает (logcat).
# Требует: собранный app-x86_64-release.apk, образ system-images;android-34;google_apis;x86_64.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../desktop/verify_lib.sh"
export ANDROID_HOME=/mnt/hdd/ub/android/sdk JAVA_HOME=/mnt/hdd/ub/android/jdk-17
# avdmanager кладёт AVD по XDG (~/.config/.android/avd), а emulator ищет в ~/.android —
# один путь для обоих
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.config/.android/avd}"; mkdir -p "$ANDROID_AVD_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
APK="$(dirname "${BASH_SOURCE[0]}")/app/build/outputs/apk/release/app-x86_64-release.apk"
[ -f "$APK" ] || { echo "нет $APK — gradle :app:assembleRelease"; exit 2; }
SB="$(mktemp -d /tmp/pv-android.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; mkdir -p "$A/td" "$B/td"
# аккаунты: headless-десктоп регистрирует при автологине
AP=$(start_client "$A" alice@local)
wait_log "$A/td/log.txt" "E2E-устройство готово" 60 && ok "alice зарегистрирована (десктоп)" || bad "alice не поднялась"
stop_pid "$AP"
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "E2E-устройство готово" 60 && ok "bob готов (десктоп)" || bad "bob не поднялся"
# эмулятор
avdmanager list avd 2>/dev/null | grep -q "Name: parvane" || \
  echo no | avdmanager create avd -n parvane -k "system-images;android-34;google_apis;x86_64" -d pixel_6 >/dev/null 2>&1
emulator -avd parvane -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -memory 2048 \
  > "$SB/emulator.log" 2>&1 & EP=$!
adb wait-for-device >/dev/null 2>&1
for _ in $(seq 1 120); do [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done
[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор загрузился" || bad "эмулятор не загрузился"
adb install -r "$APK" >/dev/null 2>&1 && ok "APK установлен" || bad "APK не установился"
adb logcat -c
adb shell am start -n org.parvane.app/.MainActivity --es gateway "ws://10.0.2.2:9222/ws" \
  --es autologin "alice@local:test" --es autosend "bob@local:from-app-$STAMP" >/dev/null 2>&1
LC="$SB/logcat.txt"
adb logcat -v time parvane:I ParvaneClient:D AndroidRuntime:E '*:S' > "$LC" 2>&1 & LP=$!
wait_log "$LC" "сессия поднята для alice@local" 90 && ok "приложение: сессия поднята" || bad "приложение: нет сессии"
wait_log "$LC" "отправлено msg .* → bob@local" 60 && ok "приложение: отправило bob" || bad "приложение: не отправило"
wait_log "$B/td/log.txt" "входящее msg .*alice@local.*from-app-$STAMP" 60 && ok "bob (десктоп) получил сообщение приложения" || bad "bob не получил"
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_AUTOSEND="alice@local:from-bob-$STAMP")
wait_log "$LC" "входящее msg .*\(bob@local\): from-bob-$STAMP" 90 && ok "приложение получило сообщение bob" || bad "приложение не получило от bob"
grep -q "AndroidRuntime" "$LC" && bad "краш приложения (AndroidRuntime)" || ok "без крашей"
kill "$LP" 2>/dev/null; adb emu kill >/dev/null 2>&1; kill "$EP" 2>/dev/null
stop_pid "$BP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ANDROID SMOKE (эмулятор)"
