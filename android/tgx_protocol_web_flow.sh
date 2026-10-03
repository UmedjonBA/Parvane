#!/usr/bin/env bash
# Протокол v2 (spec 007, T039): пара web2-android1 — web на v2 (WASM-движок) и
# Telegram X (шов) на v1 в эмуляторе, изолированный локальный стек.
# alice — X на v1 (флаг v2 выключен, журнала устройств v2 нет); bob — web с
# `parvane:proto=v2`. По правилу D-13 web обязан говорить с alice по v1:
# текст и фото web → X, ответ X → web, v2-сессия шва не поднимается.
# Нужны: x64-debug APK X с текущим libparvane_jni.so (tgx_build_x64.sh), AVD
# (по умолчанию parvane33) и обход mesa (tgx_session_flow.sh), собранный web dist
# (любой раннер web-e2e без PARVANE_E2E_SKIP_WEB_BUILD), шарды backend/target/debug,
# бинарь desktop (им регистрируется alice).
#   ./tgx_protocol_web_flow.sh        (или scripts/run_protocol_mixed_e2e.sh web2-android1)
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_ui.sh"
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -aqE \"$1\"; do sleep 3; done"; }
PKG=org.parvane.tgx; ACT="$PKG/org.thunderdog.challegram.MainActivity"
OUT="/tmp/pv-tgx-proto-web2-android1"; mkdir -p "$OUT"; S=$(date +%s)
WEB_PORT="${PV_WEB_PORT:-4179}"
[ -f "$REPO/web/telegram-tt/dist/index.html" ] || { echo "нет web/telegram-tt/dist — соберите web (любой раннер web-e2e)"; exit 2; }

pkill -x nats-server 2>/dev/null; pkill -f "backend/target/debug[/]" 2>/dev/null; pkill -f "workdir /tmp/pv-tg[x]" 2>/dev/null; sleep 2
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
A="$SB/alice"
# alice регистрируется десктопом на v1 (журнала устройств v2 у неё не будет) и гасится
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$A/td/log.txt" "E2E-устройство готово" 90 && ok "alice зарегистрирована (desktop v1)" || bad "alice не поднялась"
stop_pid "$AP"

# X как устройство alice (сессия подкладывается — экран пароля роняет qemu), v2 выключен
# файл-флагом parvane-proto-v1 (v2 включён по умолчанию, T135)
TGX_PROTO_V1=1 AVD="${AVD:-parvane33}" WAIT_SECS=20 "$HERE/tgx_session_flow.sh" "$OUT/session" alice@local "$PV_PASSWORD" >"$OUT/session-flow.log" 2>&1
grep -q "сессия поднята (ядро)" "$OUT/session-flow.log" && ok "X: сессия alice поднята" || { bad "X: сессия не поднялась (см. $OUT/session-flow.log)"; stack_stop; finish "TGX PROTO web2-android1"; }
ad shell rm -f /data/local/tmp/parvane-e2e-cmd
x_force_stop $PKG; ad logcat -c; ad shell am start -n "$ACT" >/dev/null 2>&1
xlog "сессия поднята" 60 && ok "X перезапущен" || bad "X не поднял сессию после перезапуска"
sleep 8
adb logcat -d | grep -aq "v2: сессия запускается" && bad "X: v2 поднялся без флага" || ok "X: v2 выключен по умолчанию"

# web: готовый dist через vite preview, gateway стека — ws://127.0.0.1:9222
# CSP (P-32): connect-src собирается из PARVANE_GATEWAY_ORIGIN и при preview — без него ws к gateway блокируется
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"
(cd "$REPO/web/telegram-tt" && node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$SB/web.log" 2>&1) &
WEB_PID=$!
wait_log "$SB/web.log" "http://127.0.0.1:$WEB_PORT" 60 && ok "web поднят (vite preview)" || bad "web не поднялся"

(cd "$REPO" && PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:9222" \
  PARVANE_E2E_BACKEND_LOG_DIR="$SB" PARVANE_E2E_SHOT_DIR="$OUT" PV_ANDROID_OUT="$OUT" PV_STAMP="$S" \
  node scripts/e2e_protocol_mixed_android.mjs >"$OUT/web-e2e.log" 2>&1)
RCW=$?
grep -aE "^(ok|FAIL) " "$OUT/web-e2e.log" | while read -r st rest; do [ "$st" = ok ] && ok "$rest" || bad "$rest"; done
# bad внутри конвейера живёт в подоболочке — итог берём по коду возврата сценария
[ "$RCW" = 0 ] && ok "сценарий web ↔ X пройден" || { bad "сценарий web ↔ X упал (см. $OUT/web-e2e.log)"; tail -15 "$OUT/web-e2e.log"; }
adb logcat -d | grep -aq "v2: сессия запускается" && bad "X: v2 поднялся без флага" || ok "X остался на v1"

ad logcat -d -v time > "$OUT/logcat.txt"; ad exec-out screencap -p > "$OUT/final.png"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "X: краш (AndroidRuntime)" || ok "X без крашей"
grep -aqE "запись не открыта|E2E не удался" "$OUT/logcat.txt" && bad "сбои E2E в logcat" || ok "сбоев E2E нет"
pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null; pkill -f "vite preview --host 127.0.0.1 --port $WEB_PORT" 2>/dev/null
ad shell rm -f /data/local/tmp/parvane-proto-v1
stack_stop
echo "STACK_SB=$SB OUT=$OUT"
finish "TGX PROTO web2-android1"
