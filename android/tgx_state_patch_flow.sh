#!/usr/bin/env bash
# spec 035 T134 (US2, FR-010…FR-013, STATE-1 на state.v2): web и Telegram X — два устройства одного аккаунта — БЕЗ
# связи правят РАЗНЫЕ поля одной папки (web — название, X — значок) и одного контакта (web — своё имя, X — заметка).
# X правит и останавливается без связи; правка X досылается при следующем подключении. После возвращения оба
# изменения на обоих устройствах: сведение по полям в модели движка, а правка, досланная при подключении, — разницей
# от показанного ДО неё (виды T150 — в stateAttach), а не от только что сведённого (тогда она откатывала правки web).
# Свой стек; web — диагностическая сборка (пропустить — PARVANE_E2E_SKIP_WEB_BUILD=1). Браузерная часть —
# scripts/e2e_state_patch_android.mjs. Данные — выдуманные.
#   ./tgx_state_patch_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/tmp/pv-tgx-state-patch}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
WEB_PORT="${PV_WEB_PORT:-4179}"
export VITE_PARVANE_DIAG_HOOKS=1
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"
emu_boot "$OUT" && ok "эмулятор" || { bad "эмулятор не загрузился"; finish "TGX STATE-PATCH"; }
tgx_install && ok "APK установлен" || bad "APK не установился"
if [ "${PARVANE_E2E_SKIP_WEB_BUILD:-0}" != 1 ]; then
  (cd "$REPO/web/telegram-tt" && npm run build:production >"$OUT/web-build.log" 2>&1) && ok "web собран (диаг-сборка)" \
    || { bad "web не собрался"; finish "TGX STATE-PATCH"; }
fi
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"; stack_start "$SB"; echo "STACK_SB=$SB"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
tgx_stop
: > "$TGX_LOG"; a logcat -c
adb logcat -v time >> "$TGX_LOG" 2>&1 & TGX_LCP=$!
(cd "$REPO/web/telegram-tt" && node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$OUT/web.log" 2>&1) &
WEB_PID=$!
wait_log "$OUT/web.log" "http://127.0.0.1:$WEB_PORT" 60 && ok "web поднят" || bad "web не поднялся"
(cd "$REPO" && PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:$PV_GW_WS_PORT" \
  PARVANE_E2E_BACKEND_LOG_DIR="$SB" PARVANE_E2E_SHOT_DIR="$OUT" PV_ANDROID_OUT="$OUT" TGX_LOG="$TGX_LOG" \
  PV_GW_WS_PORT="$PV_GW_WS_PORT" node scripts/e2e_state_patch_android.mjs >"$OUT/web-e2e.log" 2>&1)
RCW=$?
while read -r st rest; do [ "$st" = ok ] && ok "$rest" || bad "$rest"; done < <(grep -aE "^(ok|FAIL) " "$OUT/web-e2e.log")
[ "$RCW" = 0 ] && ok "правки разных полей без связи сошлись на web и X" \
  || { bad "сценарий web ↔ X упал (см. $OUT/web-e2e.log)"; tail -15 "$OUT/web-e2e.log"; }
sleep 2; tgx_shot "$OUT/01-state-patch.png"
pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
stack_stop
finish "TGX STATE-PATCH"
