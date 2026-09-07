#!/usr/bin/env bash
# Parvane × Telegram X — запуск форка в эмуляторе x86_64: локальный стек
# (gateway 10.0.2.2:9222 через файл /data/local/tmp/parvane-gateway), установка
# APK, старт, сводка logcat (краши, наши теги) и скриншот в $OUT.
#   ./tgx_emulator_run.sh [секунд ожидания=25]
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../desktop/verify_lib.sh"
export ANDROID_HOME=/mnt/hdd/ub/android/sdk JAVA_HOME=/mnt/hdd/ub/android/jdk-17
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.config/.android/avd}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
WAIT="${1:-25}"
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
APK="$(find "$TGX/app/build/outputs/apk" -name "*x86_64-debug.apk" | head -1)"
[ -f "$APK" ] || { echo "нет x86_64 APK форка (gradlew assembleLatestX64Debug)"; exit 2; }
OUT="${OUT_DIR:-/tmp/pv-tgx-run}"; mkdir -p "$OUT"
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"
stack_start "$SB"
B="$SB/bob"; mkdir -p "$B/td"
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "E2E-устройство готово" 60 && ok "bob (десктоп) готов" || bad "bob не поднялся"
A="$SB/alice"; mkdir -p "$A/td"; AP=$(start_client "$A" alice@local)
wait_log "$A/td/log.txt" "E2E-устройство готово" 60 && ok "alice зарегистрирована" || bad "alice не поднялась"
stop_pid "$AP"
if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; then
  emulator -avd parvane -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -memory 2048 > "$SB/emulator.log" 2>&1 &
  adb wait-for-device >/dev/null 2>&1
  for _ in $(seq 1 120); do [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done
fi
[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор" || bad "эмулятор не загрузился"
echo "ws://10.0.2.2:9222/ws" > "$SB/gw"; adb push "$SB/gw" /data/local/tmp/parvane-gateway >/dev/null 2>&1; adb shell chmod 644 /data/local/tmp/parvane-gateway
adb install -r "$APK" >/dev/null 2>&1 && ok "APK форка установлен" || bad "APK не установился"
adb logcat -c
adb shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null 2>&1
sleep "$WAIT"
adb logcat -d -v time > "$OUT/logcat.txt" 2>&1
adb exec-out screencap -p > "$OUT/screen1.png" 2>/dev/null
grep -c "AndroidRuntime" "$OUT/logcat.txt" | xargs -I{} echo "AndroidRuntime строк: {}"
grep -E "AndroidRuntime|FATAL|parvane|ParvaneClient|tdlib" "$OUT/logcat.txt" | tail -30 > "$OUT/summary.txt"
echo "скриншот: $OUT/screen1.png; сводка: $OUT/summary.txt; стек: $SB (bob/alice, пароль test)"
echo "STACK_SB=$SB BOB_PID=$BP"
