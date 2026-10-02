#!/usr/bin/env bash
# Parvane desktop — инвайт-ссылки и заявки с нативных экранов (spec 004, US4–US5).
# Хуки AUTOGROUPINVITE / AUTOGROUPJOIN / AUTOGROUPREQUEST зовут те же функции,
# что экраны «Invite Links», модалка «Join group» и «Join Requests».
#  §1 ссылки: create с лимитом 1 / истёкшая / по одобрению; list со состояниями;
#     carol вступает по лимитной (три формата ссылки), dave → exhausted;
#     expired; invalid; revoke → revoked; бан → banned; delete активной → отказ,
#     delete отозванной → ok; старая ссылка (без параметров, через nats) работает.
#  §2 заявки: dave по ссылке «по одобрению» → pending; у alice pending=1 и
#     список; approve → dave видит группу; erin decline → повтор → declined.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-group-invites}"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"; D="$SB/dave"; E="$SB/erin"
URL="nats://127.0.0.1:4222"
GNAME="Invites-$$"
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
  req identity.token.issue "{\"user\":\"$1\",\"password\":\"${PV_PASSWORD:-test-pass-2026}\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null
}
last_token() { grep -a "AUTOGROUPINVITE '$GNAME' create → ok" "$1" | tail -1 | grep -oE 'ok [0-9a-f]{32}' | cut -d' ' -f2; }
ready() { wait_log "$1/td/log.txt" "E2E-устройство готово" 40 || bad "$2 не поднялся"; }

# участники регистрируются входом (AUTOLOGIN регистрирует при отказе входа)
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1); ready "$B" bob
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1); ready "$C" carol
PD=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1); ready "$D" dave
PE=$(start_client "$E" erin@local PARVANE_NO_LINK_OFFER=1); ready "$E" erin
stop_pid "$PC"; stop_pid "$PD"; stop_pid "$PE"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local"); ready "$A" alice
GID=""
for _ in $(seq 1 40); do
  GID=$(grep -a "группа '$GNAME' создана" "$A/td/log.txt" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
  [ -n "$GID" ] && break; sleep 1
done
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"
TA=$(token_of alice@local)

# ── §1 ссылки ────────────────────────────────────────────────────────────────
mk() { # mk <create-spec> → токен в $TOK (PA обновляется в текущей оболочке — не через $(…))
  stop_pid "$PA"
  PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:$1")
  wait_log "$A/td/log.txt" "AUTOGROUPINVITE '$GNAME' create → ok" 40 || bad "create ($1) не принят"
  TOK=$(last_token "$A/td/log.txt")
}
mk "create;max=1"; T1="$TOK"; [ -n "$T1" ] && ok "US4: ссылка с лимитом 1 создана ($T1)" || bad "US4: нет T1"
mk "create;expires=$(( $(date +%s) - 10 ))"; T2="$TOK"; [ -n "$T2" ] && ok "US4: истёкшая ссылка создана" || bad "US4: нет T2"
mk "create;request=1;title=По одобрению"; T3="$TOK"; [ -n "$T3" ] && ok "US4: ссылка по одобрению создана" || bad "US4: нет T3"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:list")
wait_log "$A/td/log.txt" "ссылки $GID \(активные\): .*$T1:active:0/1:-.*" 40 && ok "US4: список — T1 active 0/1" || bad "US4: T1 не в списке активных"
wait_log "$A/td/log.txt" "ссылки $GID \(активные\): .*$T2:expired" 40 && ok "US4: список — T2 expired" || bad "US4: T2 не expired"
wait_log "$A/td/log.txt" "ссылки $GID \(активные\): .*$T3:active" 40 && ok "US4: список — T3 active (по одобрению)" || bad "US4: T3 не в списке"
grep -aE "ссылки $GID \(активные\): .*:primary" "$A/td/log.txt" >/dev/null && ok "US4: основная ссылка помечена" || bad "US4: нет основной ссылки"
# bob (участник без права) — список запрещён
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:create")
wait_log "$B/td/log.txt" "AUTOGROUPINVITE '$GNAME' create → отказ forbidden" 40 && ok "US4: участник не создаёт ссылку → forbidden" || bad "US4: участник создал ссылку"
# фото группы → превью модалки «Join group» (FR-041)
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINFO="$GNAME:avatar=$PNG")
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' avatar → ok" 40 && ok "US4: фото группы задано" || bad "US4: фото группы не задано"
# вступления
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="https://parvane.invite/$T1")
wait_log "$C/td/log.txt" "AUTOGROUPJOIN check → $GNAME members=2 request=0" 40 && ok "US4: превью перед вступлением (имя, участники)" || bad "US4: нет превью"
wait_log "$C/td/log.txt" "AUTOGROUPJOIN превью: фото группы 64x64" 40 && ok "US4: фото группы в превью (FR-041)" || bad "US4: фото группы в превью не загружено"
wait_log "$C/td/log.txt" "AUTOGROUPJOIN join → ok $GID" 40 && ok "US4: carol вступила по лимитной (формат parvane.invite)" || bad "US4: carol не вступила"
wait_log "$C/td/log.txt" "группа $GID обновлена \(v[0-9]+, список\)" 60 && ok "US4: у carol появилась группа" || bad "US4: группа не появилась у carol"
PD=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="https://web.example/#+$T1")
wait_log "$D/td/log.txt" "AUTOGROUPJOIN (check|join) → отказ exhausted" 40 && ok "US4: dave → exhausted (формат #+токен)" || bad "US4: dave не получил exhausted"
stop_pid "$PD"
PD=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="$T2")
wait_log "$D/td/log.txt" "AUTOGROUPJOIN (check|join) → отказ expired" 40 && ok "US4: истёкшая → expired (голый токен)" || bad "US4: нет expired"
stop_pid "$PD"
PD=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="https://parvane.invite/deadbeefdeadbeefdeadbeefdeadbeef")
wait_log "$D/td/log.txt" "AUTOGROUPJOIN (check|join) → отказ invalid" 40 && ok "US4: несуществующая → invalid" || bad "US4: нет invalid"
# отзыв
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:revoke:$T1")
wait_log "$A/td/log.txt" "AUTOGROUPINVITE '$GNAME' revoke $T1 → ok" 40 && ok "US4: T1 отозвана" || bad "US4: T1 не отозвана"
stop_pid "$PD"
PD=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="$T1")
wait_log "$D/td/log.txt" "AUTOGROUPJOIN (check|join) → отказ revoked" 40 && ok "US4: по отозванной → revoked" || bad "US4: нет revoked"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:list")
wait_log "$A/td/log.txt" "ссылки $GID \(отозванные\): .*$T1:revoked" 40 && ok "US4: T1 в списке отозванных" || bad "US4: T1 не в revoked"
# удаление
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:delete:$T3")
wait_log "$A/td/log.txt" "AUTOGROUPINVITE '$GNAME' delete $T3 → отказ bad_request" 40 && ok "US4: удалить активную нельзя" || bad "US4: активная удалена"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:delete:$T1")
wait_log "$A/td/log.txt" "AUTOGROUPINVITE '$GNAME' delete $T1 → ok" 40 && ok "US4: отозванная удалена" || bad "US4: отозванная не удалена"
# бан → banned
req group.ban "{\"token\":\"$TA\",\"group_id\":\"$GID\",\"member\":\"dave@local\"}" | grep -q '"ok":true' && ok "US4: dave забанен" || bad "US4: бан dave не прошёл"
stop_pid "$PD"
PD=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="$T3")
wait_log "$D/td/log.txt" "AUTOGROUPJOIN (check|join) → отказ banned" 40 && ok "US4: забаненный → banned" || bad "US4: нет banned"
stop_pid "$PD"
# старая ссылка (без параметров через nats, как до spec 003/004) работает
OLD=$(req group.invite.create "{\"token\":\"$TA\",\"group_id\":\"$GID\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("invite",""))' 2>/dev/null)
PE=$(start_client "$E" erin@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="https://parvane.invite/$OLD")
wait_log "$E/td/log.txt" "AUTOGROUPJOIN join → ok $GID" 40 && ok "US4: старая ссылка работает" || bad "US4: старая ссылка не работает"
stop_pid "$PE"
req group.removemember "{\"token\":\"$TA\",\"group_id\":\"$GID\",\"member\":\"erin@local\"}" >/dev/null

# ── §2 заявки ────────────────────────────────────────────────────────────────
req group.unban "{\"token\":\"$TA\",\"group_id\":\"$GID\",\"member\":\"dave@local\"}" >/dev/null
PD=$(start_client "$D" dave@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="$T3")
wait_log "$D/td/log.txt" "AUTOGROUPJOIN check → $GNAME members=[0-9]+ request=1" 40 && ok "US5: превью показывает «по одобрению»" || bad "US5: нет request=1 в превью"
wait_log "$D/td/log.txt" "AUTOGROUPJOIN join → pending" 40 && ok "US5: dave подал заявку" || bad "US5: заявка не создана"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPREQUEST="$GNAME:list")
wait_log "$A/td/log.txt" "группа $GID обновлена \(v[0-9]+, (список|нотис)\) .* pending=1" 40 && ok "US5: у владельца pending=1" || bad "US5: pending=1 не показан"
wait_log "$A/td/log.txt" "заявки $GID: dave@local:$T3" 40 && ok "US5: список заявок содержит dave" || bad "US5: dave не в заявках"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPREQUEST="$GNAME:list")
wait_log "$B/td/log.txt" "заявки $GID → отказ forbidden" 40 && ok "US5: участник не видит заявки → forbidden" || bad "US5: участник увидел заявки"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPREQUEST="$GNAME:approve:dave@local")
wait_log "$A/td/log.txt" "AUTOGROUPREQUEST '$GNAME' approve dave@local → ok" 40 && ok "US5: заявка одобрена" || bad "US5: approve не принят"
wait_log "$D/td/log.txt" "группа $GID обновлена \(v[0-9]+, (список|нотис)\)" 60 && ok "US5: dave видит группу после одобрения" || bad "US5: у dave нет группы"
wait_log "$A/td/log.txt" "группа $GID обновлена \(v[0-9]+, нотис\) .* pending=0" 40 && ok "US5: у владельца pending=0" || bad "US5: pending не обнулился"
PE=$(start_client "$E" erin@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="$T3")
wait_log "$E/td/log.txt" "AUTOGROUPJOIN join → pending" 40 && ok "US5: erin подала заявку" || bad "US5: заявка erin не создана"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPREQUEST="$GNAME:decline:erin@local")
wait_log "$A/td/log.txt" "AUTOGROUPREQUEST '$GNAME' decline erin@local → ok" 40 && ok "US5: заявка отклонена" || bad "US5: decline не принят"
stop_pid "$PE"
PE=$(start_client "$E" erin@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="$T3")
wait_log "$E/td/log.txt" "AUTOGROUPJOIN (check|join) → отказ declined" 40 && ok "US5: повтор после отказа → declined" || bad "US5: нет declined"

for L in "$A" "$B" "$C" "$D" "$E"; do grep -qa 'Fatal' "$L/td/log.txt" && bad "Fatal в $L"; done
ok "инварианты проверены"
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"; stop_pid "$PD"; stop_pid "$PE"; stack_stop
finish "GROUP INVITES"
