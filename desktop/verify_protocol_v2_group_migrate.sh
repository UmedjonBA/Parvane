#!/usr/bin/env bash
PV_V1_OFF=0 # сценарий сам задаёт режим v1 gateway (сначала эпоха v1, затем отключение) — общий режим «без v1» не для него
# Протокол v2 (spec 007, T180, SC-002): группа, созданная по v1, переводится в v2.
# alice (владелец), bob и carol заводят группу и переписываются по v1 (Megolm,
# шард group.*). Затем все трое обновляются до v2: клиент владельца сам создаёт
# группу v2 с тем же составом, описанием и записью о прежнем group_id; клиенты
# участников продолжают ПРЕЖНИЙ чат (история v1 остаётся в нём), новые сообщения
# идут конвертами эпохи v2 — шард v1 их больше не видит. После этого сервер можно
# перевести в PARVANE_V1_MODE=disabled: группа продолжает работать.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-group-migrate"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"
AL="$A/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
V1=(PARVANE_PROTO_V2=0 PARVANE_NO_LINK_OFFER=1)
G="Перенос-$S"; ABOUT="описание-$S"
T1="v1-групповое-$S"; T2="v2-после-перевода-$S"; T3="v2-ответ-bob-$S"; T4="v2-без-v1-$S"

# ── эпоха v1: группа, описание, сообщение ────────────────────────────────────
PB=$(start_client "$B" bob@local "${V1[@]}")
PC=$(start_client "$C" carol@local "${V1[@]}")
wait_log "$BL" "E2E-устройство готово" 60 && ok "bob: устройство v1 готово" || bad "bob не поднялся"
wait_log "$CL" "E2E-устройство готово" 60 && ok "carol: устройство v1 готово" || bad "carol не поднялась"
PA=$(start_client "$A" alice@local "${V1[@]}" "PARVANE_AUTOGROUP=$G:bob@local,carol@local" \
  "PARVANE_AUTOGROUPSEND=$G:$T1" "PARVANE_AUTOGROUPINFO=$G:about=$ABOUT")
wait_log "$AL" "группа '$G' создана: [0-9a-f-]{36}" 60 && ok "alice создала группу по v1" || bad "группа v1 не создана"
GID=$(grep -aoE "группа '$G' создана: [0-9a-f-]{36}" "$AL" | grep -oE '[0-9a-f-]{36}$' | head -1)
wait_log "$BL" "групповое .* от alice@local: $T1" 60 && ok "v1: bob прочитал групповое alice" || bad "v1: bob не прочитал групповое"
wait_log "$CL" "групповое .* от alice@local: $T1" 60 && ok "v1: carol прочитала групповое alice" || bad "v1: carol не прочитала групповое"
wait_log "$AL" "AUTOGROUPINFO '$G' about → ok" 60 && ok "v1: описание группы задано" || bad "v1: описание не задано"
V1_ROWS=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages;")
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"

# ── все трое обновляются до v2; владелец поднимается последним ────────────────
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
wait_log "$CL" "v2: готов" 90 && ok "carol: v2-сессия готова" || bad "carol: v2 не поднялся"
sleep 3
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$AL" "v2: готов" 90 && ok "alice: v2-сессия готова" || bad "alice: v2 не поднялся"
wait_log "$AL" "v2: группа v1 $GID переведена в v2g:[0-9a-f]{32}" 90 && ok "alice: группа переведена в v2" \
  || bad "alice: группа не переведена"
V2G=$(grep -aoE "группа v1 $GID переведена в v2g:[0-9a-f]{32}" "$AL" | grep -oE 'v2g:[0-9a-f]{32}' | head -1)
wait_log "$AL" "v2: группа $V2G продолжает группу v1 $GID \(тот же чат\)" 30 && ok "alice: прежний чат продолжается по v2" \
  || bad "alice: чат не связан с прежней группой"
wait_log "$BL" "v2: группа $V2G продолжает группу v1 $GID \(тот же чат\)" 60 && ok "bob: прежний чат продолжается по v2" \
  || bad "bob: группа v2 не связана с прежней"
wait_log "$CL" "v2: группа $V2G продолжает группу v1 $GID \(тот же чат\)" 60 && ok "carol: прежний чат продолжается по v2" \
  || bad "carol: группа v2 не связана с прежней"
wait_log "$BL" "группа $V2G обновлена .* about=$ABOUT " 60 && ok "bob: описание перенесено в группу v2" \
  || bad "bob: описание не перенесено"

# ── переписка в переведённой группе — по v2 ───────────────────────────────────
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOGROUPSEND=$G:$T2")
wait_log "$AL" "v2 → $V2G msg [0-9a-f-]+ \(text\)" 90 && ok "alice → группа ушло по v2 (конверт эпохи)" \
  || bad "alice: сообщение ушло не по v2"
wait_log "$BL" "групповое [0-9a-f-]+ в $V2G от alice@local: $T2" 60 && ok "bob прочитал сообщение переведённой группы" \
  || bad "bob не прочитал сообщение после перевода"
wait_log "$CL" "групповое [0-9a-f-]+ в $V2G от alice@local: $T2" 60 && ok "carol прочитала сообщение переведённой группы" \
  || bad "carol не прочитала сообщение после перевода"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOGROUPSEND=$G:$T3")
wait_log "$AL" "групповое [0-9a-f-]+ в $V2G от bob@local: $T3" 90 && ok "alice прочитала ответ bob (участник пишет в тот же чат по v2)" \
  || bad "ответ bob не дошёл"
[ "$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages;")" = "$V1_ROWS" ] && ok "новых строк в таблице сообщений v1 нет" \
  || bad "сообщения переведённой группы попали в таблицу v1"
grep -qa "группа $GID снята" "$AL" "$BL" "$CL" && bad "прежний чат снят — история v1 потеряна" || ok "прежний чат не снят"

# ── сервер отключает v1: переведённая группа работает ────────────────────────
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed PARVANE_V1_MODE=disabled"
gateway_restart
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся без v1"
wait_log "$BL" "v2: группа $V2G продолжает группу v1 $GID \(тот же чат\)" 30 && ok "bob (без v1): связь с прежней группой поднята из кэша" \
  || bad "bob (без v1): связь с прежней группой потеряна"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOGROUPSEND=$G:$T4")
wait_log "$BL" "групповое [0-9a-f-]+ в $V2G от alice@local: $T4" 90 && ok "без v1: bob прочитал сообщение группы" \
  || bad "без v1: сообщение группы не дошло"

if grep -qE "запись не открыта|ошибка записи|E2E не удался" "$AL" "$BL" "$CL"; then bad "в логах есть сбои записей v2"; else ok "сбоев записей v2 нет"; fi
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" "$CL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"
stack_stop
finish "verify_protocol_v2_group_migrate"
