#!/usr/bin/env bash
# Parvane desktop — управление группой с нативных экранов (spec 004, US1–US3).
# Экраны Edit / Permissions / Edit admin зовут те же функции, что и хуки
# PARVANE_AUTOGROUPINFO / AUTOGROUPPERMS / AUTOGROUPADMIN; сценарий проверяет:
#  §1 описание и фото: alice ставит через хук → маркер ok, у bob запись журнала с
#     about/avatar, сведения у владельца совпадают; рестарт bob — то же; bob без
#     права → отказ forbidden; 256 символов → отказ bad_request.
#  §2 права по умолчанию: цикл по всем 8 правам (SC-002) — снять, увидеть у bob,
#     сверить с сервером, вернуть; рестарт bob; bob → forbidden.
#  §3 гранулярные права админа: каждое из 6 прав по одному, admins= в маркере,
#     bob без add_admins → forbidden, снятие → role=member.
# Хуки пишут записи журнала группы v2; сведения сверяются по журналам клиентов
# (маркер «группа … обновлена (vN, v2 …)» у bob и у самой alice) — сервер видит
# только шифртекст журнала, спросить у него сведения нельзя.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-group-manage}"
A="$SB/alice"; B="$SB/bob"
GNAME="Manage-$$"
PNG="$SB/group.png"
python3 - "$PNG" <<'EOF'
import struct, sys, zlib
w = h = 64
raw = b''.join(b'\x00' + bytes([42, 171, 238]) * w for _ in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
EOF

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local")
wait_log "$A/td/log.txt" "v2: готов" 90 || bad "alice не поднялась"

GID=""
for _ in $(seq 1 40); do
  GID=$(group_gid "$A/td/log.txt" "$GNAME")
  [ -n "$GID" ] && break; sleep 1
done
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"
# Источник сведений в маркере «обновлена (vN, <источник>)» — журнал группы
# («v2 новая|журнал|кэш») и для живого изменения, и после рестарта
FIRST='v[0-9]+, v2 [^)]*'; NOTE="$FIRST"; NOTE2="$FIRST"; LIST2="$FIRST"
wait_log "$B/td/log.txt" "группа $GID обновлена \($FIRST\)" 40 \
  && ok "bob получил группу" || bad "bob не получил группу"
# Сведения группы — последняя запись журнала глазами владельца (alice):
# about=…, avatar=…, perms={…}, vN
state_about() { group_line "$A/td/log.txt" "$GID" | sed -E 's/.* about=(.*) avatar=[^ ]* perms=.*/\1/'; }
state_avatar() { group_line "$A/td/log.txt" "$GID" | sed -E 's/.* avatar=([^ ]*) perms=.*/\1/' | grep -v '^-$'; }
state_perm() { # <право> → True|False
  group_line "$A/td/log.txt" "$GID" | grep -q "\"$1\":true" && echo True || echo False
}
state_version() { group_line "$A/td/log.txt" "$GID" | sed -E 's/.*обновлена \(v([0-9]+),.*/\1/'; }

# ── §1 описание и фото (US1) ─────────────────────────────────────────────────
ABOUT="описание с экрана $$"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINFO="$GNAME:about=$ABOUT;avatar=$PNG")
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' about → ok" 40 \
  && ok "US1: описание записано в журнал группы" || bad "US1: описание не принято"
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' avatar → ok" 40 \
  && ok "US1: фото записано в журнал группы" || bad "US1: фото не принято"
wait_log "$B/td/log.txt" "группа $GID обновлена \($NOTE\) about=$ABOUT" 30 \
  && ok "US1: bob получил описание без перезагрузки" || bad "US1: описание не дошло до bob"
wait_log "$B/td/log.txt" "группа $GID обновлена \($NOTE2\) about=$ABOUT avatar=[0-9a-f-]{36}" 30 \
  && ok "US1: bob получил фото без перезагрузки" || bad "US1: фото не дошло до bob"
wait_log "$B/td/log.txt" "аватар применён для $GID" 30 \
  && ok "US1: bob скачал и применил фото" || bad "US1: фото не применено у bob"
[ "$(state_about)" = "$ABOUT" ] && ok "US1: описание в сведениях группы совпадает" || bad "US1: about в сведениях: $(state_about)"
[ -n "$(state_avatar)" ] && ok "US1: фото в сведениях группы задано" || bad "US1: avatar в сведениях пуст"
# рестарт bob — те же сведения из списка (SC-001)
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "группа $GID обновлена \($LIST2\) about=$ABOUT avatar=[0-9a-f-]{36}" 60 \
  && ok "US1: после рестарта bob — те же сведения" || bad "US1: после рестарта сведения не сошлись"
# bob без права change_info → forbidden
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINFO="$GNAME:about=взлом")
wait_log "$B/td/log.txt" "AUTOGROUPINFO '$GNAME' about → отказ forbidden" 40 \
  && ok "US1: участник без права → forbidden" || bad "US1: участник смог сменить описание"
[ "$(state_about)" = "$ABOUT" ] && ok "US1: описание не изменилось" || bad "US1: описание изменилось после отказа"
# 256 символов → bad_request
LONG=$(python3 -c 'print("я"*256)')
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINFO="$GNAME:about=$LONG")
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' about → отказ bad_request" 40 \
  && ok "US1: 256 символов → bad_request" || bad "US1: 256 символов не отклонены"

# ── §2 права по умолчанию (US2, SC-002: все 8 прав) ─────────────────────────
for right in send_messages send_media send_stickers_gifs send_polls embed_links invite_users pin_messages change_info; do
  stop_pid "$PA"
  PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:$right=0")
  wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 \
    && ok "US2: $right=0 принято" || bad "US2: $right=0 не принято"
  wait_log "$B/td/log.txt" "группа $GID обновлена \($NOTE\) .*\"$right\":false" 30 \
    && ok "US2: bob видит $right=false без перезагрузки" || bad "US2: $right=false не дошло до bob"
  # строка о группе в журнале владельца появляется чуть позже ответа хука
  for _ in $(seq 1 15); do [ "$(state_perm "$right")" = "False" ] && break; sleep 1; done
  [ "$(state_perm "$right")" = "False" ] \
    && ok "US2: в сведениях группы $right=false" || bad "US2: $right=false не сохранено"
  stop_pid "$PA"
  PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:$right=1")
  wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 || bad "US2: $right=1 не принято"
  # последние сведения у bob несут право снова включённым («true» есть и в прежних записях)
  for _ in $(seq 1 30); do group_line "$B/td/log.txt" "$GID" | grep -q "\"$right\":true" && break; sleep 1; done
  group_line "$B/td/log.txt" "$GID" | grep -q "\"$right\":true" \
    && ok "US2: $right вернулось" || bad "US2: $right=true не дошло до bob"
done
VER=$(state_version)
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:send_polls=0")
AFTER="v$VER, v2 [^)]*"
wait_log "$B/td/log.txt" "группа $GID обновлена \($AFTER\)" 60 \
  && ok "US2: после рестарта bob — та же ревизия v$VER" || bad "US2: после рестарта версия не сошлась"
wait_log "$B/td/log.txt" "AUTOGROUPPERMS '$GNAME' → отказ forbidden" 40 \
  && ok "US2: участник не меняет права → forbidden" || bad "US2: участник смог сменить права"

# ── §3 гранулярные права админа (US3, SC-002: все 6 прав) ────────────────────
for right in change_info delete_messages ban_users invite_users pin_messages add_admins; do
  stop_pid "$PA"
  PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPADMIN="$GNAME:bob@local:$right")
  wait_log "$A/td/log.txt" "AUTOGROUPADMIN '$GNAME' bob@local .* → ok" 40 \
    && ok "US3: bob админ с $right" || bad "US3: назначение $right не принято"
  case "$right" in
    change_info) F='c-----';; delete_messages) F='-d----';; ban_users) F='--b---';;
    invite_users) F='---i--';; pin_messages) F='----p-';; add_admins) F='-----a';;
  esac
  wait_log "$A/td/log.txt" "группа $GID обновлена \(v[0-9]+, [^)]*\) .* admins=bob@local:$F" 40 \
    && ok "US3: маркер admins=bob@local:$F" || bad "US3: маркер admins не содержит только $right"
  # набор прав глазами участника — тот же маркер admins= в журнале bob
  wait_log "$B/td/log.txt" "группа $GID обновлена \(v[0-9]+, [^)]*\) .* admins=bob@local:$F" 40 \
    && ok "US3: журнал группы у bob — ровно $right" || bad "US3: у bob набор прав не совпал"
done
wait_log "$B/td/log.txt" "группа $GID обновлена \($NOTE\) .* role=admin" 30 \
  && ok "US3: bob видит свою роль admin" || bad "US3: у bob нет role=admin"
# bob (только add_admins? нет — последнее право add_admins!) → сперва переназначим pin_messages
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPADMIN="$GNAME:bob@local:pin_messages")
wait_log "$A/td/log.txt" "AUTOGROUPADMIN '$GNAME' bob@local .* → ok" 40 || bad "US3: переназначение pin не принято"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOADMIN="$GNAME;remove:alice@local" PARVANE_AUTOGROUPADMIN="$GNAME:alice@local:pin_messages")
wait_log "$B/td/log.txt" "админ-действие 'remove' над alice@local в $GID(: отказ| → отказ)" 40 \
  && ok "US3: bob без ban_users не удаляет → отказ" || bad "US3: bob без ban_users удалил"
wait_log "$B/td/log.txt" "AUTOGROUPADMIN '$GNAME' alice@local .* → отказ forbidden" 40 \
  && ok "US3: bob без add_admins не назначает → forbidden" || bad "US3: bob без add_admins назначил"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPADMIN="$GNAME:bob@local:")
wait_log "$A/td/log.txt" "AUTOGROUPADMIN '$GNAME' bob@local .* → ok" 40 \
  && ok "US3: снятие админа принято" || bad "US3: снятие не принято"
for _ in $(seq 1 30); do group_line "$B/td/log.txt" "$GID" | grep -q "role=member" && break; sleep 1; done
group_line "$B/td/log.txt" "$GID" | grep -q "role=member" \
  && ok "US3: bob снова member" || bad "US3: bob не стал member"

# инварианты
grep -qa 'Fatal' "$A/td/log.txt" "$B/td/log.txt" && bad "Fatal в логах" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "GROUP MANAGE"
