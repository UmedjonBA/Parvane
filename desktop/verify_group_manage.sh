#!/usr/bin/env bash
# Parvane desktop — управление группой с нативных экранов (spec 004, US1–US3).
# Экраны Edit / Permissions / Edit admin зовут те же функции, что и хуки
# PARVANE_AUTOGROUPINFO / AUTOGROUPPERMS / AUTOGROUPADMIN; сценарий проверяет:
#  §1 описание и фото: alice ставит через хук → маркер ok, у bob нотис с about/
#     avatar, group.info совпадает; рестарт bob — то же из списка; bob без права
#     → отказ forbidden; 256 символов → отказ bad_request.
#  §2 права по умолчанию: цикл по всем 8 правам (SC-002) — снять, увидеть у bob,
#     сверить с сервером, вернуть; рестарт bob; bob → forbidden.
#  §3 гранулярные права админа: каждое из 6 прав по одному, admins= в маркере,
#     bob без add_admins → forbidden, снятие → role=member.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-group-manage}"
A="$SB/alice"; B="$SB/bob"
URL="nats://127.0.0.1:4222"
GNAME="Manage-$$"
NATS="${NATS_CLI:-$HOME/.local/bin/nats}"
PNG="$SB/group.png"
python3 - "$PNG" <<'EOF'
import struct, sys, zlib
w = h = 64
raw = b''.join(b'\x00' + bytes([42, 171, 238]) * w for _ in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
EOF

req() { "$NATS" --server "$URL" req "$1" "$2" 2>/dev/null | grep -o '{.*}' | head -1; }
token_of() {
  req identity.token.issue "{\"user\":\"$1\",\"password\":\"test\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null
}
group_info() { # <token> → JSON GroupInfo
  req group.info "{\"token\":\"$1\",\"group_id\":\"$GID\"}" \
    | python3 -c 'import sys,json;g=json.load(sys.stdin).get("groups",[]);print(json.dumps(g[0]) if g else "{}")' 2>/dev/null
}
field() { python3 -c 'import sys,json;d=json.loads(sys.argv[1]);print(eval("d"+sys.argv[2]))' "$1" "$2" 2>/dev/null; }

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local")
wait_log "$A/td/log.txt" "E2E-устройство готово" 40 || bad "alice не поднялась"

GID=""
for _ in $(seq 1 40); do
  GID=$(grep -a "группа '$GNAME' создана" "$A/td/log.txt" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
  [ -n "$GID" ] && break; sleep 1
done
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"
wait_log "$B/td/log.txt" "группа $GID обновлена \(v0, список\)" 40 \
  && ok "bob получил группу (v0, список)" || bad "bob не получил группу"
TA=$(token_of alice@local); TB=$(token_of bob@local)
[ -n "$TA" ] && [ -n "$TB" ] && ok "токены получены" || bad "нет токенов"

# ── §1 описание и фото (US1) ─────────────────────────────────────────────────
ABOUT="описание с экрана $$"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINFO="$GNAME:about=$ABOUT;avatar=$PNG")
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' about → ok" 40 \
  && ok "US1: описание принято сервером" || bad "US1: описание не принято"
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' avatar → ok" 40 \
  && ok "US1: фото принято сервером" || bad "US1: фото не принято"
wait_log "$B/td/log.txt" "группа $GID обновлена \(v[12], нотис\) about=$ABOUT" 30 \
  && ok "US1: bob получил описание нотисом" || bad "US1: описание не дошло до bob"
wait_log "$B/td/log.txt" "группа $GID обновлена \(v2, нотис\) about=$ABOUT avatar=[0-9a-f-]{36}" 30 \
  && ok "US1: bob получил фото нотисом (v2)" || bad "US1: фото не дошло до bob"
wait_log "$B/td/log.txt" "аватар применён для $GID" 30 \
  && ok "US1: bob скачал и применил фото" || bad "US1: фото не применено у bob"
INFO=$(group_info "$TA")
[ "$(field "$INFO" '["about"]')" = "$ABOUT" ] && ok "US1: group.info about совпадает" || bad "US1: about на сервере: $(field "$INFO" '["about"]')"
[ -n "$(field "$INFO" '["avatar"]')" ] && ok "US1: group.info avatar задан" || bad "US1: avatar на сервере пуст"
# рестарт bob — те же сведения из списка (SC-001)
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "группа $GID обновлена \(v2, список\) about=$ABOUT avatar=[0-9a-f-]{36}" 60 \
  && ok "US1: после рестарта bob — v2 из списка" || bad "US1: после рестарта сведения не сошлись"
# bob без права change_info → forbidden
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINFO="$GNAME:about=взлом")
wait_log "$B/td/log.txt" "AUTOGROUPINFO '$GNAME' about → отказ forbidden" 40 \
  && ok "US1: участник без права → forbidden" || bad "US1: участник смог сменить описание"
[ "$(field "$(group_info "$TA")" '["about"]')" = "$ABOUT" ] && ok "US1: описание не изменилось" || bad "US1: описание изменилось после отказа"
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
  wait_log "$B/td/log.txt" "группа $GID обновлена \(v[0-9]+, нотис\) .*\"$right\":false" 30 \
    && ok "US2: bob видит $right=false нотисом" || bad "US2: $right=false не дошло до bob"
  [ "$(field "$(group_info "$TA")" "[\"default_permissions\"][\"$right\"]")" = "False" ] \
    && ok "US2: сервер хранит $right=false" || bad "US2: сервер не сохранил $right=false"
  stop_pid "$PA"
  PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:$right=1")
  wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 || bad "US2: $right=1 не принято"
  wait_log "$B/td/log.txt" "группа $GID обновлена \(v[0-9]+, нотис\) .*\"$right\":true" 30 \
    && ok "US2: $right вернулось" || bad "US2: $right=true не дошло до bob"
done
VER=$(field "$(group_info "$TA")" '["version"]')
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:send_polls=0")
wait_log "$B/td/log.txt" "группа $GID обновлена \(v$VER, список\)" 60 \
  && ok "US2: после рестарта bob — v$VER из списка" || bad "US2: после рестарта версия не сошлась"
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
  wait_log "$A/td/log.txt" "группа $GID обновлена \(v[0-9]+, (нотис|список)\) .* admins=bob@local:$F" 40 \
    && ok "US3: маркер admins=bob@local:$F" || bad "US3: маркер admins не содержит только $right"
  RIGHTS=$(field "$(group_info "$TA")" '["members"]')
  echo "$RIGHTS" | python3 -c "
import sys,ast
ms=ast.literal_eval(sys.stdin.read())
b=[m for m in ms if m['address']=='bob@local'][0]
r=b.get('admin_rights',{})
ok = b['role']=='admin' and r.get('$right') and sum(1 for v in r.values() if v)==1
sys.exit(0 if ok else 1)" && ok "US3: сервер — ровно $right" || bad "US3: сервер — набор не совпал"
done
wait_log "$B/td/log.txt" "группа $GID обновлена \(v[0-9]+, нотис\) .* role=admin" 30 \
  && ok "US3: bob видит свою роль admin" || bad "US3: у bob нет role=admin"
# bob (только add_admins? нет — последнее право add_admins!) → сперва переназначим pin_messages
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPADMIN="$GNAME:bob@local:pin_messages")
wait_log "$A/td/log.txt" "AUTOGROUPADMIN '$GNAME' bob@local .* → ok" 40 || bad "US3: переназначение pin не принято"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOADMIN="$GNAME;remove:alice@local" PARVANE_AUTOGROUPADMIN="$GNAME:alice@local:pin_messages")
wait_log "$B/td/log.txt" "админ-действие 'remove' над alice@local в $GID: отказ" 40 \
  && ok "US3: bob без ban_users не удаляет → отказ" || bad "US3: bob без ban_users удалил"
wait_log "$B/td/log.txt" "AUTOGROUPADMIN '$GNAME' alice@local .* → отказ forbidden" 40 \
  && ok "US3: bob без add_admins не назначает → forbidden" || bad "US3: bob без add_admins назначил"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPADMIN="$GNAME:bob@local:")
wait_log "$A/td/log.txt" "AUTOGROUPADMIN '$GNAME' bob@local .* → ok" 40 \
  && ok "US3: снятие админа принято" || bad "US3: снятие не принято"
wait_log "$B/td/log.txt" "группа $GID обновлена \(v[0-9]+, нотис\) .* role=member" 30 \
  && ok "US3: bob снова member" || bad "US3: bob не стал member"

# инварианты
grep -qa 'Fatal' "$A/td/log.txt" "$B/td/log.txt" && bad "Fatal в логах" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "GROUP MANAGE"
