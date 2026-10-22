#!/usr/bin/env bash
# Parvane Android (spec 031): общая обвязка сценариев эмулятора форка Telegram X — только протокол v2.
# Подключать ПОСЛЕ ../desktop/verify_lib.sh (стек, desktop-клиенты, ok/bad/finish). Даёт:
#   tgx_env          — пути SDK/эмулятора, обход регрессии mesa (если распакована ~/.local/mesa-26.2.1)
#   emu_boot <out>   — поднять AVD (${AVD:-parvane33}), если не поднят; гость без автозаполнения и Gboard
#   tgx_install      — поставить свежий x64-debug APK X
#   tgx_fresh <user> — чистый старт приложения: pm clear, gateway стека, вход dev-хуком (ник:пароль)
#   tgx_cmd <json>   — команда e2e-хука шва (/data/local/tmp/parvane-e2e-cmd), ждёт её выполнения
#   tgx_logwait <regex> [сек=60] — дождаться строки в logcat (поток пишется в $TGX_LOG)
# Логи шва: тег parvane (ядро/JNI) и ParvaneClient (Kotlin).
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
TGX_PKG=org.parvane.tgx
a() { timeout 25 adb "$@"; } # эмулятор может умереть — каждая команда с таймаутом
tgx_env() {
  export ANDROID_HOME=/mnt/hdd/ub/android/sdk JAVA_HOME=/mnt/hdd/ub/android/jdk-17
  export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.config/.android/avd}"
  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$HOME/.local/bin:$PATH"
  local mesa="${PV_MESA:-$HOME/.local/mesa-26.2.1}"
  if [ "${PV_MESA_OLD:-0}" = 1 ] && [ -d "$mesa/usr/lib" ]; then
    export LD_LIBRARY_PATH="$mesa/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export LIBGL_DRIVERS_PATH="$mesa/usr/lib/dri"
    export __EGL_VENDOR_LIBRARY_DIRS="$mesa/usr/share/glvnd/egl_vendor.d"
    export VK_ICD_FILENAMES="$mesa/usr/share/vulkan/icd.d/intel_icd.json"
  fi
}
emu_boot() {
  local out="$1"
  if [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; then
    pkill -f "emulator -avd ${AVD:-parvane33}" 2>/dev/null; sleep 2
    # shellcheck disable=SC2086
    emulator -avd "${AVD:-parvane33}" -no-window -audio none -no-boot-anim -gpu "${EMU_GPU:-host}" -no-snapshot \
      -memory 2048 ${EMU_EXTRA:-} > "$out/emulator.log" 2>&1 &
    for _ in $(seq 1 150); do [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done
  fi
  [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] || return 1
  a root >/dev/null 2>&1; sleep 2
  a shell settings put secure autofill_service null >/dev/null 2>&1
  a shell pm disable-user --user 0 com.google.android.inputmethod.latin >/dev/null 2>&1
  a shell settings put secure show_ime_with_hard_keyboard 0 >/dev/null 2>&1
  return 0
}
tgx_apk() { find "$TGX/app/build/outputs/apk" -name "*-x64-debug.apk" | head -1; }
tgx_install() { a install -r "$(tgx_apk)" >/dev/null 2>&1; }
# tgx_put <файл гостя> <текст> — файл в /data/local/tmp (читает debug-сборка шва)
tgx_put() {
  local tmp; tmp="$(mktemp)"; printf '%s' "$2" > "$tmp"
  a push "$tmp" "/data/local/tmp/$1" >/dev/null 2>&1; a shell chmod 644 "/data/local/tmp/$1"; rm -f "$tmp"
}
tgx_fresh() { # tgx_fresh <ник@сервер> [пароль]
  a shell am force-stop "$TGX_PKG" >/dev/null 2>&1; sleep 1
  a shell pm clear "$TGX_PKG" >/dev/null 2>&1
  a shell pm grant "$TGX_PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1
  a shell rm -f /data/local/tmp/parvane-e2e-cmd /data/local/tmp/parvane-autolink >/dev/null 2>&1
  # gateway стека — через adb reverse (127.0.0.1 гостя → 127.0.0.1 хоста): сеть эмулятора (netsim) 10.0.2.2 не всегда
  # пробрасывает, а обратный порт adb не зависит от неё
  a reverse "tcp:$PV_GW_WS_PORT" "tcp:$PV_GW_WS_PORT" >/dev/null 2>&1
  tgx_put parvane-gateway "ws://127.0.0.1:$PV_GW_WS_PORT/ws"
  tgx_put parvane-autologin "$1:${2:-$PV_PASSWORD}"
  tgx_start
}
# Запуск приложения и живой logcat в $TGX_LOG (перезапуск — с новым файлом)
tgx_start() {
  [ -n "${TGX_LCP:-}" ] && kill "$TGX_LCP" 2>/dev/null
  # чужой `adb logcat` в тот же файл (прерванный прошлый прогон) затирал строки своим смещением — гасим
  local p
  for p in $(pgrep -x adb 2>/dev/null); do
    [ "$(readlink "/proc/$p/fd/1" 2>/dev/null)" = "$(readlink -f "$TGX_LOG" 2>/dev/null)" ] && kill "$p" 2>/dev/null
  done
  # logcat сценария — один файл на весь сценарий: перезапуск дописывает (иначе ранние шаги не разобрать)
  [ "${TGX_LOG_STARTED:-}" = "$TGX_LOG" ] || { : > "$TGX_LOG"; TGX_LOG_STARTED="$TGX_LOG"; }
  TGX_MARK=$(( $(wc -l < "$TGX_LOG" 2>/dev/null || echo 0) + 1 ))
  # Краш прошлого сценария (он уже отмечен в своём логе) уводит debug-X в режим восстановления («Aw, Snap!»):
  # X не шлёт параметры, шов молчит — следующие сценарии падали каскадом. Метки краша стираем.
  a shell run-as "$TGX_PKG" sh -c 'rm -f files/logs/crash.*' >/dev/null 2>&1
  local alive; alive="$(a shell pidof "$TGX_PKG" 2>/dev/null | tr -d '\r')"
  if [ -n "$alive" ]; then echo "tgx_start: X уже запущен (pid $alive) — останавливаю" >&2; tgx_stop; fi
  a logcat -c
  adb logcat -v time >> "$TGX_LOG" 2>&1 & TGX_LCP=$!
  a shell am start -n "$TGX_PKG/org.thunderdog.challegram.MainActivity" >/dev/null 2>&1
}
# Остановка — до исчезновения процесса (am force-stop возвращается раньше; процесс, доживший до tgx_start, терял
# начало журнала после logcat -c, и «v2: готов» не находилось)
tgx_stop() {
  a shell am force-stop "$TGX_PKG" >/dev/null 2>&1
  for _ in $(seq 1 20); do [ -z "$(a shell pidof "$TGX_PKG" 2>/dev/null | tr -d '\r')" ] && break; sleep 0.5; done
  sleep 1
}
# tgx_mark — дальше tgx_logwait смотрит только новые строки logcat (после отметки)
tgx_mark() { TGX_MARK=$(( $(wc -l < "$TGX_LOG" 2>/dev/null || echo 0) + 1 )); }
tgx_logwait() {
  local n="${2:-60}"
  for _ in $(seq 1 "$n"); do
    tail -n "+${TGX_MARK:-1}" "$TGX_LOG" 2>/dev/null | grep -qaE "$1" && return 0
    sleep 1
  done
  return 1
}
tgx_cmd() { # tgx_cmd <json> [маркер-regex ожидания]
  tgx_put parvane-e2e-cmd "$1"
  local op; op="$(printf '%s' "$1" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("op",""))')"
  tgx_logwait "e2e-cmd $op →" 20
}
tgx_shot() { a exec-out screencap -p > "$1"; }
tgx_no_crash() {
  if grep -q "FATAL EXCEPTION" "$TGX_LOG"; then
    bad "краш X: $(grep -A3 'FATAL EXCEPTION' "$TGX_LOG" | tail -2 | tr '\n' ' ' | cut -c1-200)"
  elif grep -aq "Fatal signal .*($TGX_PKG)\|>>> $TGX_PKG <<<" "$TGX_LOG"; then
    # нативное падение (SIGABRT/SIGSEGV в ядре или JNI) — Java-краша нет, приложение просто исчезает
    bad "нативный краш X: $(grep -a 'Abort message\|Fatal signal' "$TGX_LOG" | head -2 | tr '\n' ' ' | cut -c1-200)"
  else ok "без крашей"; fi
}
