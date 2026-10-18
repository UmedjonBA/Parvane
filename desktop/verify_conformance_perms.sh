#!/usr/bin/env bash
# Parvane desktop — CONFORMANCE GROUP-2 (conformance/sync-rules.json, spec 004).
# Права по типу содержимого соблюдаются на клиенте:
#  1. владелец alice снимает send_media (хук AUTOGROUPPERMS = экран «Permissions»);
#  2. участник bob шлёт файл В ОБХОД композера (AUTOGROUPSENDFILE bypass=1) —
#     движок bob отклоняет конверт (forbidden), у carol файла нет;
#     текст bob при этом доставлен;
#  3. владелец alice шлёт файл — у carol НЕ скрыт (владелец не фильтруется);
#  4. композер (FR-021): bob без bypass → «запрещено правами (…)», отправки нет;
#  5. alice возвращает send_media — следующий файл bob виден у carol.
# Права группы v2 — записи журнала, и их по виду содержимого соблюдает сам движок:
# отправку в обход композера (шаг 2) он отклоняет у отправителя (`forbidden`),
# приёмный фильтр движка покрыт векторами `content_guard`.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-conformance-perms}"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"
GNAME="Perms-$$"
FILE="$SB/payload.bin"
head -c 4096 /dev/urandom > "$FILE"

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не поднялся"
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$C/td/log.txt" "v2: готов" 90 || bad "carol не поднялась"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local,carol@local")
wait_log "$A/td/log.txt" "v2: готов" 90 || bad "alice не поднялась"
GID=""
for _ in $(seq 1 40); do
  GID=$(group_gid "$A/td/log.txt" "$GNAME")
  [ -n "$GID" ] && break; sleep 1
done
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"
# Источник сведений в маркере — журнал группы («vN, v2 новая|журнал|кэш»)
FIRST='v[0-9]+, v2 [^)]*'
wait_log "$B/td/log.txt" "группа $GID обновлена \($FIRST\)" 40 || bad "bob не получил группу"
wait_log "$C/td/log.txt" "группа $GID обновлена \($FIRST\)" 40 || bad "carol не получила группу"
# Последние применённые сведения группы несут send_media=<значение>
wait_media_perm() { # wait_media_perm <log> <true|false> [сек=30]
  for _ in $(seq 1 "${3:-30}"); do
    group_line "$1" "$GID" | grep -q "\"send_media\":$2" && return 0; sleep 1
  done
  return 1
}

# 1. владелец снимает send_media
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:send_media=0")
wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 && ok "send_media снят владельцем" || bad "send_media не снят"
wait_media_perm "$B/td/log.txt" false && ok "bob получил права" || bad "bob не получил права"
wait_media_perm "$C/td/log.txt" false && ok "carol получила права" || bad "carol не получила права"

# 2. bob в обход: файл скрыт у получателей, текст доставлен
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSENDFILE="$GNAME:$FILE;bypass=1" PARVANE_AUTOGROUPSEND="$GNAME:текст bob разрешён")
wait_log "$B/td/log.txt" "AUTOGROUPSENDFILE → отправлено" 40 && ok "bob отправил файл в обход" || bad "bob не отправил файл в обход"
# право по виду содержимого проверяет движок отправителя — конверт не уходит
wait_log "$B/td/log.txt" "отправка в группу $GID не удалась: .*forbidden" 40 \
  && ok "GROUP-2: движок bob отклонил файл в обход композера (forbidden)" || bad "GROUP-2: движок bob не отклонил файл"
wait_log "$C/td/log.txt" "групповое .* от bob@local: текст bob разрешён" 40 \
  && ok "GROUP-2: текст bob доставлен (фильтр только по типу)" || bad "GROUP-2: текст bob не доставлен"
grep -qa "групповое медиа .* от bob@local" "$C/td/log.txt" && bad "GROUP-2: медиа bob всё же инъецировано у carol" || ok "GROUP-2: медиа bob не инъецировано у carol"

# 3. владелец шлёт файл — не фильтруется
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSENDFILE="$GNAME:$FILE")
wait_log "$A/td/log.txt" "AUTOGROUPSENDFILE → отправлено" 40 && ok "владелец отправил файл (композер не блокирует)" || bad "владелец не отправил файл"
wait_log "$C/td/log.txt" "групповое медиа .* от alice@local" 60 \
  && ok "GROUP-2: файл владельца у carol показан" || bad "GROUP-2: файл владельца у carol не показан"
grep -qa "от alice@local скрыто правами группы" "$C/td/log.txt" && bad "GROUP-2: файл владельца скрыт" || ok "GROUP-2: владелец не фильтруется"

# 4. композер участника без права блокирует (FR-021)
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSENDFILE="$GNAME:$FILE")
wait_log "$B/td/log.txt" "AUTOGROUPSENDFILE → запрещено правами" 40 \
  && ok "FR-021: композер участника без send_media блокирует файл" || bad "FR-021: композер не заблокировал"
sleep 5
grep -qa "AUTOGROUPSENDFILE → отправлено" "$B/td/log.txt" && bad "FR-021: файл всё же отправлен" || ok "FR-021: отправки не было"

# 5. право возвращено — файл bob виден
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:send_media=1")
wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 && ok "send_media возвращён" || bad "send_media не возвращён"
wait_media_perm "$B/td/log.txt" true || bad "bob не получил возврат права"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSENDFILE="$GNAME:$FILE")
wait_log "$B/td/log.txt" "AUTOGROUPSENDFILE → отправлено" 40 && ok "bob с правом отправил файл штатно" || bad "bob с правом не отправил"
wait_log "$C/td/log.txt" "групповое медиа .* от bob@local" 60 \
  && ok "GROUP-2: после возврата права файл bob у carol показан" || bad "GROUP-2: файл bob после возврата права не показан"

# инварианты
for L in "$A" "$B" "$C"; do grep -qa 'Fatal' "$L/td/log.txt" && bad "Fatal в $L"; done
ok "инварианты проверены"
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"; stack_stop
finish "CONFORMANCE GROUP-2"
