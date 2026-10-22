#!/usr/bin/env bash
# Групповой звонок на X (spec 031, T057/T058; CALL-2) после tgx_session_flow.sh (стек, X — alice, bob — desktop):
#   bob создаёт группу с alice (X) и carol (desktop, принимает сам) и звонит в неё; X получает приглашение с
#   названием группы, принимает (e2e-хук = кнопка «Принять») → сетка на троих: у X два участника «на связи»,
#   у bob и carol — по два соединения; X выходит.
#   ./tgx_group_call_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-group-call}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); B="$SB/bob"; C="$SB/carol"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
G="ГК$(date +%s | tail -c 5)"
a shell pm grant "$TGX_PKG" android.permission.RECORD_AUDIO >/dev/null 2>&1
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 PARVANE_AUTOACCEPT=1)
wait_log "$CL" "v2: готов" 90 || bad "carol: v2 не поднялся"
tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 "PARVANE_AUTOGROUP=$G:alice@local,carol@local" "PARVANE_AUTOGROUPCALL=$G")
wait_log "$BL" "AUTOGROUPCALL в '$G'" 120 && ok "bob позвонил в группу" || bad "bob не начал групповой звонок"
tgx_logwait "групповой звонок: invite" 90 && ok "X: приглашение в групповой звонок" || bad "X: приглашения нет"
sleep 2; tgx_shot "$OUT/01-invite.png"
tgx_cmd '{"op":"group_call_accept","peer":"bob@local"}' && ok "X: принял" || bad "X: не принял"
cnt() { local n; n=$(grep -ac 'groupcall .* → Active' "$1" 2>/dev/null); echo "${n:-0}"; }
xcnt() { local n; n=$(sed -n "${TGX_MARK},\$p" "$TGX_LOG" | grep -acE "групповой звонок: peer [a-z0-9_]+ → active"); echo "${n:-0}"; }
for _ in $(seq 1 90); do
  [ "$(xcnt)" -ge 2 ] && [ "$(cnt "$BL")" -ge 2 ] && [ "$(cnt "$CL")" -ge 2 ] && break
  sleep 1
done
[ "$(xcnt)" -ge 2 ] && ok "X соединён с двумя участниками" || bad "X: сетка неполная ($(xcnt))"
[ "$(cnt "$BL")" -ge 2 ] && ok "bob соединён с двумя участниками" || bad "bob: сетка неполная ($(cnt "$BL"))"
[ "$(cnt "$CL")" -ge 2 ] && ok "carol соединена с двумя участниками" || bad "carol: сетка неполная ($(cnt "$CL"))"
sleep 2; tgx_shot "$OUT/02-call.png"
tgx_cmd '{"op":"group_call_leave","peer":"bob@local"}' && ok "X вышел из звонка" || bad "X не вышел"
stop_pid "$BP"; stop_pid "$CP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX GROUP CALL"
