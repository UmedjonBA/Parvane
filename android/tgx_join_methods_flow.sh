#!/usr/bin/env bash
# Новое устройство получает всё сразу после входа — все три способа, Telegram X и web вперемешку (отзыв 23–24 окт
# 2026). Свой стек с ботом Telegram (роль бота играет сценарий): web — первое устройство (переписка, группа, канал,
# «План», «Облако»); X входит ответом боту, ключом руками и подтверждением с web; web входит после X (копия ключей,
# записанная Android, не «беднеет») и подтверждением с X. Браузерная часть — scripts/e2e_protocol_join_android.mjs.
# После tgx_session_flow.sh (APK установлен, эмулятор поднят); X теряет прежний аккаунт — ставить в конец волны.
# Web — диагностическая сборка (пропустить — PARVANE_E2E_SKIP_WEB_BUILD=1).
#   ./tgx_join_methods_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/tmp/pv-tgx-join-methods}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
WEB_PORT="${PV_WEB_PORT:-4179}"
BOT=parvane_e2e_bot
BOT_SECRET=parvane-e2e-telegram-secret
SB="$(mktemp -d /tmp/pv-tgx-join.XXXXXX)"
stack_start "$SB" PARVANE_TELEGRAM_BOT="$BOT" PARVANE_TELEGRAM_SECRET="$BOT_SECRET"
echo "STACK_SB=$SB"
export VITE_PARVANE_DIAG_HOOKS=1
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"
if [ "${PARVANE_E2E_SKIP_WEB_BUILD:-0}" != 1 ]; then
  (cd "$REPO/web/telegram-tt" && npm run build:production >"$OUT/web-build.log" 2>&1) && ok "web собран (диаг-сборка)" \
    || { bad "web не собрался"; finish "TGX JOIN METHODS"; }
fi
tgx_stop
: > "$TGX_LOG"; a logcat -c
adb logcat -v time >> "$TGX_LOG" 2>&1 & TGX_LCP=$!
(cd "$REPO/web/telegram-tt" && node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$OUT/web.log" 2>&1) &
WEB_PID=$!
wait_log "$OUT/web.log" "http://127.0.0.1:$WEB_PORT" 60 && ok "web поднят" || bad "web не поднялся"
(cd "$REPO" && PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:$PV_GW_WS_PORT" \
  PARVANE_E2E_BACKEND_LOG_DIR="$SB" PV_ANDROID_OUT="$OUT" TGX_LOG="$TGX_LOG" PV_GW_WS_PORT="$PV_GW_WS_PORT" \
  PARVANE_TELEGRAM_BOT="$BOT" PARVANE_TELEGRAM_SECRET="$BOT_SECRET" \
  node scripts/e2e_protocol_join_android.mjs >"$OUT/web-e2e.log" 2>&1)
RCW=$?
while read -r st rest; do [ "$st" = ok ] && ok "$rest" || bad "$rest"; done < <(grep -aE "^(ok|FAIL) " "$OUT/web-e2e.log")
grep -a "всё прежнее через" "$OUT/web-e2e.log" | sed 's/^ */     /'
[ "$RCW" = 0 ] && ok "все способы входа: всё сразу" || { bad "сценарий входа упал (см. $OUT/web-e2e.log)"; tail -25 "$OUT/web-e2e.log"; }
sleep 2; tgx_shot "$OUT/01-after.png"
pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
stack_stop
finish "TGX JOIN METHODS"
