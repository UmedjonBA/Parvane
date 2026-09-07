#!/usr/bin/env bash
# Форк Telegram X в эмуляторе с ЗАРАНЕЕ выданной сессией (минуя экран пароля, на
# котором падает хостовый qemu): токен через nats → files/tdlib/session.json
# приложения (run-as, debug-сборка) → запуск → Ready → список чатов.
#   ./tgx_session_flow.sh [OUT_DIR] [user=alice@local] [password=test]
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-session}"; USER_="${2:-alice@local}"; PASS="${3:-test}"; mkdir -p "$OUT"
. "$ROOT/../desktop/verify_lib.sh"
export ANDROID_HOME=/mnt/hdd/ub/android/sdk JAVA_HOME=/mnt/hdd/ub/android/jdk-17
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.config/.android/avd}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$HOME/.local/bin:$PATH"
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
APK="$(find "$TGX/app/build/outputs/apk" -name "*-x64-debug.apk" | head -1)"
a() { timeout 25 adb "$@"; }
pgrep -x nats-server >/dev/null || { echo "нет локального стека (tgx_login_flow.sh поднимает)"; exit 2; }
TOKEN="$(nats --server nats://127.0.0.1:4222 req identity.token.issue "{\"user\":\"$USER_\",\"password\":\"$PASS\"}" --raw 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')"
[ -n "$TOKEN" ] && ok "токен для $USER_ выдан" || { bad "identity не выдал токен"; finish "TGX SESSION"; }
if [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; then
  pkill -f "emulator -avd parvane" 2>/dev/null; sleep 2
  # shellcheck disable=SC2086
  emulator -avd parvane -no-window -audio none -no-boot-anim -gpu "${EMU_GPU:-guest}" -no-snapshot -memory 2048 ${EMU_EXTRA:-} > "$OUT/emulator.log" 2>&1 &
  for _ in $(seq 1 150); do [ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break; sleep 2; done
fi
[ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор" || { bad "эмулятор не загрузился"; finish "TGX SESSION"; }
echo "ws://10.0.2.2:9222/ws" > "$OUT/gw"; a push "$OUT/gw" /data/local/tmp/parvane-gateway >/dev/null 2>&1; a shell chmod 644 /data/local/tmp/parvane-gateway
a install -r "$APK" >/dev/null 2>&1 && ok "APK установлен" || bad "APK не установился"
a shell pm clear org.parvane.tgx >/dev/null 2>&1
printf '{"self":"%s","token":"%s"}' "$USER_" "$TOKEN" > "$OUT/session.json"
a push "$OUT/session.json" /data/local/tmp/parvane-session.json >/dev/null 2>&1
# run-as: по одной команде (sh -c с && через adb ломает кавычки)
a shell run-as org.parvane.tgx mkdir -p files/tdlib
a shell run-as org.parvane.tgx cp /data/local/tmp/parvane-session.json files/tdlib/session.json && ok "session.json подложен" || bad "run-as не сработал"
a logcat -c
adb logcat -v time > "$OUT/logcat.txt" 2>&1 & LCP=$!
a shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null 2>&1
sleep "${WAIT_SECS:-25}"; a exec-out screencap -p > "$OUT/01-main.png"
sleep 2; kill "$LCP" 2>/dev/null
grep -q "сессия поднята" "$OUT/logcat.txt" && ok "сессия поднята (ядро)" || bad "сессии нет"
grep -q "AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "без крашей"
grep -oE "не реализовано: [A-Za-z]+" "$OUT/logcat.txt" | sort | uniq -c | sort -rn > "$OUT/unimplemented.txt"
echo "не реализовано (топ): $(head -12 "$OUT/unimplemented.txt" | awk '{print $NF"("$1")"}' | tr '\n' ' ')"
finish "TGX SESSION"
