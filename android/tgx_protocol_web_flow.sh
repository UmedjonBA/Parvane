#!/usr/bin/env bash
# Пара web2-android2 (spec 031, T040): web (WASM-движок v2) ↔ Telegram X (шов, v2) после tgx_session_flow.sh
# (его стек на 4222/9222, X — alice). Web — диагностическая сборка (`VITE_PARVANE_DIAG_HOOKS=1`, адрес gateway
# из localStorage) собирается сценарием (пропустить — `PARVANE_E2E_SKIP_WEB_BUILD=1`). Браузерная часть — scripts/e2e_protocol_mixed_android.mjs:
# текст, фото, голосовое web → X, ответ X → web, группа v2 web → X.
#   ./tgx_protocol_web_flow.sh [OUT_DIR]   (или scripts/run_protocol_mixed_e2e.sh web2-android2)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/tmp/pv-tgx-web2-android2}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
S=$(date +%s); WEB_PORT="${PV_WEB_PORT:-4179}"
SB=$(\ls -td /tmp/pv-tgx.* | head -1)
export VITE_PARVANE_DIAG_HOOKS=1
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"
# Сборка web — всегда (в dist может лежать боевая сборка после деплоя); пропустить — PARVANE_E2E_SKIP_WEB_BUILD=1
if [ "${PARVANE_E2E_SKIP_WEB_BUILD:-0}" != 1 ]; then
  (cd "$REPO/web/telegram-tt" && npm run build:production >"$OUT/web-build.log" 2>&1) && ok "web собран (диаг-сборка)" || { bad "web не собрался"; finish "TGX WEB2-ANDROID2"; }
fi
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"
(cd "$REPO/web/telegram-tt" && node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$OUT/web.log" 2>&1) &
WEB_PID=$!
wait_log "$OUT/web.log" "http://127.0.0.1:$WEB_PORT" 60 && ok "web поднят" || bad "web не поднялся"
(cd "$REPO" && PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:9222" \
  PARVANE_E2E_BACKEND_LOG_DIR="$SB" PARVANE_E2E_SHOT_DIR="$OUT" PV_ANDROID_OUT="$OUT" PV_STAMP="$S" \
  node scripts/e2e_protocol_mixed_android.mjs >"$OUT/web-e2e.log" 2>&1)
RCW=$?
while read -r st rest; do [ "$st" = ok ] && ok "$rest" || bad "$rest"; done < <(grep -aE "^(ok|FAIL) " "$OUT/web-e2e.log")
[ "$RCW" = 0 ] && ok "сценарий web ↔ X пройден" || { bad "сценарий web ↔ X упал (см. $OUT/web-e2e.log)"; tail -15 "$OUT/web-e2e.log"; }
pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX WEB2-ANDROID2"
