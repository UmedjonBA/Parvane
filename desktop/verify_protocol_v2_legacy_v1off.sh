#!/usr/bin/env bash
PV_V1_OFF=0 # сценарий сам задаёт режим v1 gateway (либо проверяет транспорт v1) — общий режим «без v1» не для него
# Протокол v2 (spec 007, T134, FR-053 — этап E6): история v1 после отключения v1.
# Аккаунты заведены и переписывались по v1; пока bob был выключен, alice написала
# ему ещё раз (сообщение осталось в инбоксе v1). Затем сервер переведён в
# PARVANE_V1_MODE=disabled, клиенты обновлены до v2: JSON-соединения v1 нет, и
# недоставленное сообщение v1 bob получает записью `LegacyV1` инбокса v2 — тем же
# обработчиком инбокса; дальше переписка идёт по v2.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-legacy-v1off"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A="$SB/alice"; B="$SB/bob"
AL="$A/td/log.txt"; BL="$B/td/log.txt"
V1=(PARVANE_PROTO_V2=0 PARVANE_NO_LINK_OFFER=1)
T1="v1-до-$S"; T2="v1-пока-выключен-$S"; T3="v2-после-$S"; T4="v2-ответ-$S"

# ── эпоха v1: переписка и сообщение выключенному получателю ──────────────────
PB=$(start_client "$B" bob@local "${V1[@]}")
wait_log "$BL" "E2E-устройство готово" 60 && ok "bob: устройство v1 готово" || bad "bob не поднялся"
PA=$(start_client "$A" alice@local "${V1[@]}" "PARVANE_AUTOSEND=bob@local:$T1")
wait_log "$BL" "входящее msg .* \(alice@local\): $T1" 60 && ok "v1: bob получил сообщение alice" \
  || bad "v1: сообщение не дошло"
stop_pid "$PB"; stop_pid "$PA"
sleep 2
PA=$(start_client "$A" alice@local "${V1[@]}" "PARVANE_AUTOSEND=bob@local:$T2")
wait_log "$AL" "E2E-устройство готово" 60 || bad "alice не поднялась"
sleep 8
stop_pid "$PA"
[ "$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages;")" -ge 2 ] && ok "v1: оба сообщения в таблице v1" \
  || bad "v1: сообщений в таблице меньше двух"

# ── сервер отключает v1, клиенты обновлены до v2 ─────────────────────────────
GW_LINES=$(wc -l < "$SB/gateway.log")
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed PARVANE_V1_MODE=disabled"
gateway_restart
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
wait_log "$BL" "соединения v1 нет .* все запросы идут по v2" 30 && ok "bob: соединения v1 нет" \
  || bad "bob: нет отметки о работе без v1"
wait_log "$BL" "входящее msg .* \(alice@local\): $T2" 90 \
  && ok "bob получил сообщение v1, отправленное до отключения (запись LegacyV1)" \
  || bad "bob не получил сообщение v1 из LegacyV1"

# ── дальше — по v2 ───────────────────────────────────────────────────────────
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=bob@local:$T3")
wait_log "$AL" "v2: готов" 90 && ok "alice: v2-сессия готова" || bad "alice: v2 не поднялся"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): $T3" 60 && ok "bob получил сообщение alice по v2" \
  || bad "сообщение v2 не дошло"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:$T4")
wait_log "$AL" "входящее msg [0-9a-f-]+ \(bob@local\): $T4" 90 && ok "alice получила ответ bob по v2" \
  || bad "ответ v2 не дошёл"

# ── после отключения v1 не использовался ─────────────────────────────────────
tail -n +"$((GW_LINES + 1))" "$SB/gateway.log" > "$SB/gateway-after.log"
grep -qa "v1-путь в режиме Disabled" "$SB/gateway-after.log" && ok "gateway: v1 отключён" || bad "gateway не в режиме disabled"
grep -qa "gateway::session.*Клиент авторизован" "$SB/gateway-after.log" && bad "после отключения кто-то авторизовался по v1" \
  || ok "после отключения по v1 не авторизовался никто"
[ "$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages;")" = "2" ] && ok "новых строк в таблице v1 нет" \
  || bad "в таблице v1 появились новые сообщения"
grep -qa "upgrade_required. — нужна новая версия" "$AL" "$BL" && bad "клиент показал «обновите приложение»" \
  || ok "диалога «обновите приложение» нет"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_legacy_v1off"
