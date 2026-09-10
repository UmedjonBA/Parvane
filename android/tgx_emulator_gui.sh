#!/usr/bin/env bash
# Эмулятор С ОКНОМ для ручного теста форка X (Parvane) — ничего качать не надо:
# SDK/эмулятор/AVD уже стоят на HDD. Ставит свежий x64-APK из сборки и запускает.
# Вход — ник/пароль от прода (по умолчанию APK ходит на wss://parvane.duckdns.org:20443/ws),
# ключи — линковка: подтвердить на вебе/десктопе. Логи: adb logcat -s parvane ParvaneClient tgx AndroidRuntime
set -u
export JAVA_HOME=/mnt/hdd/ub/android/jdk-17 ANDROID_HOME=/mnt/hdd/ub/android/sdk ANDROID_SDK_ROOT=/mnt/hdd/ub/android/sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.config/.android/avd}"
# обход падения qemu после апдейта mesa 26.2.2 (см. CLAUDE.md): пользовательская mesa 26.2.1 + хостовый GPU
PV_MESA="${PV_MESA:-$HOME/.local/mesa-26.2.1}"
if [ -d "$PV_MESA/usr/lib" ]; then
  export LD_LIBRARY_PATH="$PV_MESA/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export LIBGL_DRIVERS_PATH="$PV_MESA/usr/lib/dri"
  export __EGL_VENDOR_LIBRARY_DIRS="$PV_MESA/usr/share/glvnd/egl_vendor.d"
  export VK_ICD_FILENAMES="$PV_MESA/usr/share/vulkan/icd.d/intel_icd.json"
  EMU_GPU="${EMU_GPU:-host}"
fi
AVD="${AVD:-parvane33}"
APK="${APK:-$(ls -t /mnt/hdd/ub/android/tgx/app/build/outputs/apk/latestX64/debug/*-x64-debug.apk 2>/dev/null | head -1)}"
a() { timeout 25 adb "$@"; }
if [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; then
  echo "== эмулятор $AVD (окно) =="
  emulator -avd "$AVD" -gpu "${EMU_GPU:-swiftshader_indirect}" -no-snapshot -memory 2048 \
    ${EMU_EXTRA:--feature -Vulkan,-VirtioWifi,-BluetoothEmulation} > /tmp/pv-emulator-gui.log 2>&1 &
  for _ in $(seq 1 150); do [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done
fi
[ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] || { echo "эмулятор не загрузился, см. /tmp/pv-emulator-gui.log"; exit 1; }
a shell settings put secure autofill_service null >/dev/null 2>&1   # обход падения qemu (Gboard/автозаполнение)
a shell pm disable-user --user 0 com.google.android.inputmethod.latin >/dev/null 2>&1
# следы автотестов: файл с адресом dev-gateway (иначе приложение пойдёт на 10.0.2.2, а не на прод) и тестовая сессия
a shell rm -f /data/local/tmp/parvane-gateway /data/local/tmp/parvane-session.json >/dev/null 2>&1
if [ "${FRESH:-1}" = "1" ]; then a shell pm clear org.parvane.tgx >/dev/null 2>&1; fi   # FRESH=0 — сохранить вход
if [ -n "$APK" ]; then
  echo "== ставлю $(basename "$APK") =="
  a install -r "$APK" >/dev/null && echo "   установлен" || echo "   не установился"
  a shell pm grant org.parvane.tgx android.permission.POST_NOTIFICATIONS >/dev/null 2>&1
fi
a shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null 2>&1
echo "готово: окно эмулятора открыто, Parvane запущен. Логи: adb logcat -s parvane ParvaneClient tgx AndroidRuntime"
