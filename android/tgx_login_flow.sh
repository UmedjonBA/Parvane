#!/usr/bin/env bash
# Автопрогон входа в форке Telegram X на эмуляторе: интро → ник → пароль → список
# чатов; скриншоты и logcat в $OUT. Стек/эмулятор переиспользуются, если живы.
#   ./tgx_login_flow.sh [OUT_DIR] [nick=alice] [password=test]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-login}"; NICK="${2:-alice}"; PASS="${3:-test}"; mkdir -p "$OUT"
. "$ROOT/../desktop/verify_lib.sh"
export ANDROID_HOME=/mnt/hdd/ub/android/sdk JAVA_HOME=/mnt/hdd/ub/android/jdk-17
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.config/.android/avd}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
# Обход регрессии mesa 26.2.2 (10 сен 2026): хостовый qemu падал SIGSEGV с
# тяжёлым UI Telegram X. Если распакована mesa 26.2.1 (~/.local/mesa-26.2.1,
# `tar -xf` пакетов из archive.archlinux.org), эмулятор берёт GL/Vulkan из неё
# и рендерит на хостовом GPU — система не трогается. Иначе swiftshader.
PV_MESA="${PV_MESA:-$HOME/.local/mesa-26.2.1}"
if [ -d "$PV_MESA/usr/lib" ]; then
  export LD_LIBRARY_PATH="$PV_MESA/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LIBGL_DRIVERS_PATH="$PV_MESA/usr/lib/dri"
  export __EGL_VENDOR_LIBRARY_DIRS="$PV_MESA/usr/share/glvnd/egl_vendor.d"
  export VK_ICD_FILENAMES="$PV_MESA/usr/share/vulkan/icd.d/intel_icd.json"
  EMU_GPU="${EMU_GPU:-host}"
fi
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
APK="$(find "$TGX/app/build/outputs/apk" -name "*-x64-debug.apk" | head -1)"
a() { timeout 25 adb "$@"; }   # каждая adb-команда с таймаутом — эмулятор может умереть
if ! pgrep -x nats-server >/dev/null; then
  SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"; stack_start "$SB"
  B="$SB/bob"; mkdir -p "$B/td"; BP=$(start_client "$B" bob@local)
  wait_log "$B/td/log.txt" "E2E-устройство готово" 60 && ok "bob (десктоп) готов" || bad "bob не поднялся"
  A="$SB/alice"; mkdir -p "$A/td"; AP=$(start_client "$A" alice@local)
  wait_log "$A/td/log.txt" "E2E-устройство готово" 60 && ok "alice зарегистрирована" || bad "alice не поднялась"
  stop_pid "$AP"; echo "STACK_SB=$SB"
else
  ok "стек уже запущен (переиспользую)"
fi
if [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; then
  pkill -f "emulator -avd ${AVD:-parvane}" 2>/dev/null; sleep 2
  # хостовый swiftshader падал (segfault) на экране пароля X — по умолчанию рендер в госте
  # shellcheck disable=SC2086
  emulator -avd "${AVD:-parvane}" -no-window -audio none -no-boot-anim -gpu "${EMU_GPU:-swiftshader_indirect}" -no-snapshot -memory 2048 ${EMU_EXTRA:--feature -Vulkan,-VirtioWifi,-BluetoothEmulation} > "$OUT/emulator.log" 2>&1 &
  for _ in $(seq 1 150); do [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done
fi
[ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор" || { bad "эмулятор не загрузился"; finish "TGX LOGIN"; }
echo "ws://10.0.2.2:9222/ws" > "$OUT/gw"; a push "$OUT/gw" /data/local/tmp/parvane-gateway >/dev/null 2>&1; a shell chmod 644 /data/local/tmp/parvane-gateway
a install -r "$APK" >/dev/null 2>&1 && ok "APK установлен" || bad "APK не установился"
a shell pm clear org.parvane.tgx >/dev/null 2>&1   # чистый старт: интро → ник
a logcat -c
# logcat стримим с самого старта — если эмулятор упадёт, последние строки приложения останутся
adb logcat -v time > "$OUT/logcat.txt" 2>&1 & LCP=$!
a shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null 2>&1
sleep 12; a exec-out screencap -p > "$OUT/01-intro.png"
a shell input tap 540 2232; sleep 4; a exec-out screencap -p > "$OUT/02-nick.png"
a shell input text "$NICK"; sleep 1; a shell input tap 963 1400; sleep 5; a exec-out screencap -p > "$OUT/03-password.png"
a shell input text "$PASS"; sleep 1; a shell input tap 963 1400; sleep 12; a exec-out screencap -p > "$OUT/04-after-login.png"
sleep 2; kill "$LCP" 2>/dev/null
grep -q "сессия поднята" "$OUT/logcat.txt" && ok "сессия поднята (ядро)" || bad "сессии нет"
grep -q "AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "без крашей"
grep -oE "не реализовано: [A-Za-z]+" "$OUT/logcat.txt" | sort | uniq -c | sort -rn | head -20 > "$OUT/unimplemented.txt"
echo "не реализовано (топ): $(head -8 "$OUT/unimplemented.txt" | awk '{print $NF"("$1")"}' | tr '\n' ' ')"
finish "TGX LOGIN"
