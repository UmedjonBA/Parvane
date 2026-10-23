#!/usr/bin/env bash
# Вход нового устройства по ключу восстановления (RECOVER-2, spec 032): группы появляются сразу, а не «потом»
# (отзыв 23 окт 2026: после ключа в Telegram сначала было 3 чата, группы и канал — позже). После tgx_session_flow.sh
# (его стек; bob — desktop). Свой аккаунт dave:
#   1) X регистрирует dave, пишет bob, создаёт две группы с bob; копия ключей аккаунта уходит на сервер;
#   2) данные X стёрты — X входит тем же ником новым устройством (нужна привязка) и вводит ключ восстановления;
#   3) обе группы и личный чат появляются в списке X не позже 20 с после вступления, «План» первого устройства —
#      тоже (ключ «Плана» из копии ключей аккаунта; другого устройства, которое прислало бы ключ, нет).
#   ./tgx_recovery_groups_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-recovery-groups}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(ls -td /tmp/pv-tgx.* | head -1); B="$SB/bob"
DAVE="dave$(date +%s | tail -c 6)@local"

# 1) первое устройство dave
tgx_fresh "$DAVE"
tgx_logwait "v2: готов" 120 && ok "$DAVE вошёл (первое устройство)" || bad "первое устройство не поднялось"
KEY=""
for _ in $(seq 1 30); do
  KEY=$(a shell "run-as $TGX_PKG cat files/tdlib/e2e-recovery-key.txt 2>/dev/null" | tr -d '\r' | head -1)
  [ -n "$KEY" ] && break; sleep 1
done
[ -n "$KEY" ] && ok "ключ восстановления выдан" || bad "ключа восстановления нет"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=$DAVE:privet-dave")
wait_log "$B/td/log.txt" "autosend → $DAVE" 60 || bad "bob не написал"
tgx_logwait "v2 ← входящее msg" 60 && ok "личный чат с bob" || bad "сообщения bob нет"
stop_pid "$BP"
for g in "Klub-$RANDOM" "Kanal-$RANDOM"; do
  tgx_mark; tgx_cmd "{\"op\":\"group_create\",\"title\":\"$g\",\"members\":[\"bob@local\"]}"
  tgx_logwait "группа .* объявлен=true" 30 && ok "группа $g создана" || bad "группа $g не создана"
done
TASK="Zadacha-$RANDOM"
tgx_cmd '{"op":"sections","section":"calendar"}' || bad "«План» не открыт"
tgx_cmd "{\"op\":\"planner_add\",\"text\":\"$TASK\"}"
tgx_logwait "planner: status=ready loaded=1 задачи=\[[^]]*$TASK" 60 && ok "задача в «Плане» первого устройства" || bad "задача не добавлена"
tgx_mark
tgx_logwait "копия ключей аккаунта обновлена" 150 && ok "копия ключей аккаунта на сервере" || bad "копия ключей не обновилась"

# 2) новое устройство тем же ником
tgx_fresh "$DAVE"
tgx_logwait "устройству нужна привязка" 120 && ok "новое устройство ждёт привязки" || bad "нет запроса привязки"
tgx_mark
T0=$(date +%s)
tgx_cmd "{\"op\":\"recover_key\",\"key\":\"$KEY\"}"
tgx_logwait "вход по ключу → ok" 60 && ok "вход по ключу" || bad "вход по ключу не прошёл ($(grep -ao 'вход по ключу → .*' "$TGX_LOG" | tail -1))"

# 3) группы — сразу
GOT=0
for _ in $(seq 1 40); do
  GOT=$(tail -n "+$TGX_MARK" "$TGX_LOG" | grep -ac "группа .* объявлен=true")
  [ "$GOT" -ge 2 ] && break; sleep 1
done
DT=$(( $(date +%s) - T0 ))
[ "$GOT" -ge 2 ] && [ "$DT" -le 30 ] && ok "обе группы в списке через ${DT} с после ключа" || bad "групп в списке: $GOT за ${DT} с"
tgx_shot "$OUT/chats-after-key.png"
tgx_cmd '{"op":"sections","section":"calendar"}' || bad "«План» не открыт"
tgx_logwait "planner: status=ready loaded=1 задачи=\[[^]]*$TASK" 40 \
  && ok "«План» первого устройства через $(( $(date +%s) - T0 )) с после ключа" || bad "задачи первого устройства в «Плане» нет"
tgx_shot "$OUT/plan-after-key.png"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX RECOVERY GROUPS"
