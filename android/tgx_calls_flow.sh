#!/usr/bin/env bash
# Звонки (spec 031, US3) после tgx_session_flow.sh (стек, X alice, bob desktop, переписка уже была — D-08):
#   1) bob (desktop, настоящий webrtc) звонит alice; X принимает (хук = кнопка «Ответить») → оба Active;
#   2) X завершает → у bob звонок закончен;
#   3) X звонит bob (desktop авто-принимает) → оба Active, медиа соединились (ICE/DTLS), X завершает.
#   ./tgx_calls_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-calls}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(ls -td /tmp/pv-tgx.* | head -1); B="$SB/bob"; BL="$B/td/log.txt"
a shell pm grant "$TGX_PKG" android.permission.RECORD_AUDIO >/dev/null 2>&1
a shell pm grant "$TGX_PKG" android.permission.CAMERA >/dev/null 2>&1
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"
# 1) входящий
tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 PARVANE_AUTOCALL=alice@local)
tgx_logwait "звонок: входящий" 90 && ok "X: входящий звонок от bob" || bad "X: входящего нет"
sleep 2; tgx_shot "$OUT/01-incoming.png"
tgx_cmd '{"op":"call_accept","peer":"bob@local"}' && ok "X: принят" || bad "X: не принят"
tgx_logwait "ParvaneWebrtc.*соединение .*: (CONNECTED|COMPLETED)" 60 && ok "X: медиа соединились (ICE/DTLS)" || bad "X: медиа не соединились"
tgx_logwait "звонок → CallStateReady" 30 && ok "X: экран звонка — идёт разговор" || bad "X: состояние Ready не пришло"
wait_log "$BL" "звонок → Active" 30 && ok "bob → Active" || bad "bob не дошёл до Active"
sleep 3; tgx_shot "$OUT/02-active.png"
# 2) X завершает
tgx_cmd '{"op":"call_hangup","peer":"bob@local"}' && ok "X: завершил" || bad "X: не завершил"
wait_log "$BL" "звонок → Ended" 30 && ok "bob: звонок окончен" || bad "bob: звонок не окончен"
tgx_logwait "звонок → CallStateDiscarded" 20 && ok "X: экран звонка закрыт" || bad "X: звонок не закрыт"
stop_pid "$BP"
# 3) исходящий из X
tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 PARVANE_AUTOACCEPT=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
tgx_cmd '{"op":"call","peer":"bob@local","video":false}' && ok "X: звонит bob" || bad "X: не позвонил"
wait_log "$BL" "ВХОДЯЩИЙ звонок от alice@local" 60 && ok "bob: входящий от X" || bad "bob: входящего от X нет"
tgx_logwait "ParvaneWebrtc.*соединение .*: (CONNECTED|COMPLETED)" 60 && ok "X → bob: медиа соединились" || bad "X → bob: медиа не соединились"
wait_log "$BL" "звонок → Active" 30 && ok "bob → Active (исходящий X)" || bad "bob не дошёл до Active"
tgx_cmd '{"op":"call_hangup","peer":"bob@local"}' >/dev/null
stop_pid "$BP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX CALLS"
