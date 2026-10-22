#!/usr/bin/env bash
# Пара sections-android (spec 031, T068): разделы «План», «Знания», «Облако» web ↔ Telegram X одного аккаунта.
# web — первое устройство нового аккаунта, X входит им же с чистыми данными и привязывается грантом web; данные
# разделов идут в обе стороны. Браузерная часть — scripts/e2e_protocol_sections_android.mjs. Стек — последний
# /tmp/pv-tgx.* (после tgx_protocol_link_flow.sh; X теряет прежний аккаунт — ставить после сценариев этого стека).
# Web — диагностическая сборка (пропустить — PARVANE_E2E_SKIP_WEB_BUILD=1).
#   ./tgx_protocol_sections_web_flow.sh [OUT_DIR]   (или scripts/run_protocol_mixed_e2e.sh sections-android)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/tmp/pv-tgx-sections-web}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
WEB_PORT="${PV_WEB_PORT:-4179}"
SB=$(\ls -td /tmp/pv-tgx.* | head -1)
export VITE_PARVANE_DIAG_HOOKS=1
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"
if [ "${PARVANE_E2E_SKIP_WEB_BUILD:-0}" != 1 ]; then
  (cd "$REPO/web/telegram-tt" && npm run build:production >"$OUT/web-build.log" 2>&1) && ok "web собран (диаг-сборка)" || { bad "web не собрался"; finish "TGX SECTIONS-ANDROID"; }
fi
tgx_stop
: > "$TGX_LOG"; a logcat -c
adb logcat -v time >> "$TGX_LOG" 2>&1 & TGX_LCP=$!
(cd "$REPO/web/telegram-tt" && node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$OUT/web.log" 2>&1) &
WEB_PID=$!
wait_log "$OUT/web.log" "http://127.0.0.1:$WEB_PORT" 60 && ok "web поднят" || bad "web не поднялся"
(cd "$REPO" && PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:$PV_GW_WS_PORT" \
  PARVANE_E2E_BACKEND_LOG_DIR="$SB" PARVANE_E2E_SHOT_DIR="$OUT" PV_ANDROID_OUT="$OUT" TGX_LOG="$TGX_LOG" \
  PV_GW_WS_PORT="$PV_GW_WS_PORT" node scripts/e2e_protocol_sections_android.mjs >"$OUT/web-e2e.log" 2>&1)
RCW=$?
while read -r st rest; do [ "$st" = ok ] && ok "$rest" || bad "$rest"; done < <(grep -aE "^(ok|FAIL) " "$OUT/web-e2e.log")
[ "$RCW" = 0 ] && ok "сценарий разделов web ↔ X пройден" || { bad "сценарий разделов web ↔ X упал (см. $OUT/web-e2e.log)"; tail -15 "$OUT/web-e2e.log"; }
sleep 2; tgx_shot "$OUT/01-sections.png"
pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX SECTIONS-ANDROID"
