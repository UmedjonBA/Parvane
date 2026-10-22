#!/usr/bin/env bash
# Группы v2 в X (spec 031; GROUP-1/2/3) после tgx_session_flow.sh (стек, X — alice, bob — desktop):
#   1) bob создаёт группу с alice (X) и carol → X: группа появилась из журнала группы, чат в списке;
#   2) bob снимает send_media → X: права применены (UpdateChatPermissions) — GROUP-1;
#   3) carol пишет текст → X получил; X пишет в группу → bob получил;
#   4) bob создаёт ссылку, dave вступает → X: состав обновлён (UpdateBasicGroupFullInfo);
#   5) bob возвращает send_media, carol шлёт файл → X показал медиа группы.
#   ./tgx_group_manage_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-group-manage}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); B="$SB/bob"; C="$SB/carol"; D="$SB/dave"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
G="pvgroup-$(date +%s)"; FILE="$OUT/payload.bin"; head -c 4096 /dev/urandom > "$FILE"
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$CL" "v2: готов" 90 || bad "carol не поднялась"
# 1) группа
tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$G:alice@local,carol@local")
GID=""; for _ in $(seq 1 60); do GID=$(group_gid "$BL" "$G"); [ -n "$GID" ] && break; sleep 1; done
[ -n "$GID" ] && ok "bob создал группу ($GID)" || bad "группа не создана"
tgx_logwait "группа v2 $GID (появилась|обновлена)" 90 && ok "X: группа появилась (журнал группы)" || bad "X: группа не появилась"
tgx_logwait "→ X UpdateNewChat" 30 && ok "X: чат группы в списке" || bad "X: чат группы не объявлен"
# 2) права
tgx_mark; stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$G:send_media=0")
wait_log "$BL" "AUTOGROUPPERMS '$G' → ok" 60 && ok "bob снял send_media" || bad "send_media не снят"
tgx_logwait "→ X UpdateChatPermissions" 60 && ok "GROUP-1 (X): права применены без перезапуска" || bad "GROUP-1 (X): права не пришли"
# 3) переписка в группе
tgx_mark; stop_pid "$CP"
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSEND="$G:privet-gruppa")
tgx_logwait "сообщение [0-9a-f-]{36} → чат -[0-9]+ \(вх\)" 90 && ok "X получил текст carol в группе" || bad "X не получил текст группы"
tgx_cmd "{\"op\":\"send\",\"peer\":\"$GID\",\"text\":\"otvet-gruppe\"}" && ok "X написал в группу" || bad "X не написал в группу"
wait_log "$BL" "групповое .* от alice@local: otvet-gruppe" 60 && ok "bob получил сообщение X в группе" || bad "bob не получил сообщение X"
# 4) ссылка и вступление
tgx_mark; stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$G:create")
wait_log "$BL" "AUTOGROUPINVITE '$G' create → ok" 60 && ok "bob создал ссылку" || bad "ссылка не создана"
URL=$(grep -a "AUTOGROUPINVITE '$G' create → ok" "$BL" | tail -1 | sed -E 's/.* create → ok ([^ ]+).*/\1/')
DP=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1)
wait_log "$D/td/log.txt" "v2: готов" 90 || bad "dave не поднялся"
stop_pid "$DP"
DP=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="$URL")
wait_log "$D/td/log.txt" "AUTOGROUPJOIN join → ok" 60 && ok "dave вступил по ссылке" || bad "dave не вступил ($URL)"
tgx_logwait "→ X UpdateBasicGroupFullInfo" 60 && ok "GROUP-1 (X): состав обновлён" || bad "GROUP-1 (X): состав не обновлён"
# 5) право возвращено → медиа carol показано
tgx_mark; stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$G:send_media=1")
wait_log "$BL" "AUTOGROUPPERMS '$G' → ok" 60 && ok "send_media возвращён" || bad "send_media не возвращён"
tgx_logwait "→ X UpdateChatPermissions" 60 || bad "X: возврат права не пришёл"
stop_pid "$CP"
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSENDFILE="$G:$FILE")
wait_log "$CL" "AUTOGROUPSENDFILE → отправлено" 60 && ok "carol отправила файл" || bad "carol не отправила файл"
tgx_logwait "v2 ← входящее msg [0-9a-f-]{36} \((file|photo)\)" 90 && ok "GROUP-2 (X): файл с правом показан" || bad "GROUP-2 (X): файл не пришёл"
sleep 3; tgx_shot "$OUT/01-group.png"
stop_pid "$BP"; stop_pid "$CP"; stop_pid "$DP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX GROUP MANAGE"
