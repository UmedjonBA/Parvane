#!/usr/bin/env bash
# Итерация форка Telegram X на уже запущенном эмуляторе/стеке (tgx_emulator_run.sh):
# оверлей → инкрементальная сборка x64 → переустановка → запуск → logcat + скриншот.
#   ./tgx_iterate.sh [секунд ожидания=25] [OUT_DIR]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAIT="${1:-25}"; OUT="${2:-/tmp/pv-tgx-iter}"; mkdir -p "$OUT"
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
export ANDROID_HOME=/mnt/hdd/ub/android/sdk ANDROID_SDK_ROOT=/mnt/hdd/ub/android/sdk
export PATH="/mnt/hdd/ub/android/sdk/platform-tools:/mnt/hdd/ub/android/tools/bin:$PATH"
"$ROOT/setup-tgx.sh" > "$OUT/setup.log" 2>&1 || { echo "оверлей упал: $OUT/setup.log"; exit 2; }
(cd "$TGX" && JAVA_HOME=/mnt/hdd/ub/android/jdk-21 PATH=/mnt/hdd/ub/android/jdk-21/bin:$PATH \
  ./gradlew assembleLatestX64Debug --no-daemon --console=plain > "$OUT/gradle.log" 2>&1) || { grep -E "^e: |error:|What went wrong" -A3 "$OUT/gradle.log" | head -20; exit 3; }
APK="$(find "$TGX/app/build/outputs/apk" -name "*-x64-debug.apk" | head -1)"
adb install -r "$APK" >/dev/null 2>&1 || { echo "install failed"; exit 4; }
adb shell am force-stop org.parvane.tgx >/dev/null 2>&1
adb logcat -c
adb shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null 2>&1
sleep "$WAIT"
adb logcat -d -v time > "$OUT/logcat.txt" 2>&1
adb exec-out screencap -p > "$OUT/screen.png" 2>/dev/null
echo "AndroidRuntime: $(grep -c AndroidRuntime "$OUT/logcat.txt")  parvane-строк: $(grep -c 'parvane\|ParvaneClient' "$OUT/logcat.txt")"
grep -E "FATAL|AndroidRuntime.*(Exception|Error|at org)" "$OUT/logcat.txt" | head -12 | cut -c1-200
grep -E "ParvaneClient|I/parvane|E/parvane" "$OUT/logcat.txt" | tail -15 | cut -c1-200
echo "OUT=$OUT"
