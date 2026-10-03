#!/usr/bin/env bash
# Протокол v2 (spec 007, T143): ссылки-приглашения и ЗАЯВКИ на вступление в
# группе v2 с тех же экранов, что и v1 (хуки AUTOGROUPINVITE / AUTOGROUPJOIN /
# AUTOGROUPREQUEST = экраны «Invite Links», модалка «Join group», «Join Requests»).
#  §1 ссылки: с лимитом 1 и «по одобрению»; carol вступает по лимитной, dave по
#     исчерпанной — отказ; отзыв ссылки → по ней больше не вступить.
#  §2 заявки: dave по ссылке «по одобрению» → pending; владелец alice узнаёт о
#     заявке БЕЗ перезагрузки (pending=1 — уведомление о группе без смены версии),
#     видит её в списке, одобряет → dave получает группу и читает сообщение новой
#     эпохи; заявка erin отклоняется (журнал группы не меняется), повторная
#     заявка после отказа снова принимается к рассмотрению.
# Модель v1 (токены, состояния ссылок, список отозванных) — verify_group_invites.sh.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s); G="Inv2-$S"
stack_start "${SCRATCH:-/tmp/parvane-v2-invites}"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"; D="$SB/dave"; E="$SB/erin"
AL="$A/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"; DL="$D/td/log.txt"; EL="$E/td/log.txt"
V2=(PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
LINK='https://[^ ]+/join/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}'

# Участники — первыми: их журналы устройств v2 должны существовать до создания
PB=$(start_client "$B" bob@local "${V2[@]}")
PC=$(start_client "$C" carol@local "${V2[@]}")
PD=$(start_client "$D" dave@local "${V2[@]}")
PE=$(start_client "$E" erin@local "${V2[@]}")
for who in bob carol dave erin; do
  wait_log "$SB/$who/td/log.txt" "v2: готов" 90 && ok "$who: v2-сессия готова" || bad "$who: v2 не поднялся"
done
stop_pid "$PC"; stop_pid "$PD"; stop_pid "$PE"
PA=$(start_client "$A" alice@local "${V2[@]}" "PARVANE_AUTOGROUP=$G:bob@local")
wait_log "$AL" "группа v2 '$G' создана: v2g:[0-9a-f]{32}" 60 && ok "alice: группа v2 создана" || bad "alice: группа v2 не создана"
GID=$(group_gid "$AL" "$G")
wait_log "$BL" "v2: группа $GID появилась" 60 && ok "bob: группа из журнала ($GID)" || bad "bob: группа не появилась"

# ── §1 ссылки ────────────────────────────────────────────────────────────────
mk() { # mk <create-spec> → ссылка в $URL (PA обновляется в текущей оболочке)
  stop_pid "$PA"
  PA=$(start_client "$A" alice@local "${V2[@]}" "PARVANE_AUTOGROUPINVITE=$G:$1")
  wait_log "$AL" "AUTOGROUPINVITE '$G' create → ok $LINK" 60 || bad "create ($1) не принят"
  URL=$(grep -aoE "AUTOGROUPINVITE '$G' create → ok https://[^ ]+" "$AL" | tail -1 | sed 's/.* ok //')
}
mk "create;max=1"; T1="$URL"; [ -n "$T1" ] && ok "ссылка v2 с лимитом 1 создана" || bad "нет ссылки с лимитом"
mk "create;request=1;title=По одобрению"; T3="$URL"; [ -n "$T3" ] && [ "$T3" != "$T1" ] && ok "ссылка v2 по одобрению создана" || bad "нет ссылки по одобрению"
PC=$(start_client "$C" carol@local "${V2[@]}" "PARVANE_AUTOGROUPJOIN=$T1")
wait_log "$CL" "AUTOGROUPJOIN check → $G members=2 request=0" 90 && ok "carol: превью перед вступлением (имя, участники)" || bad "carol: нет превью"
wait_log "$CL" "AUTOGROUPJOIN join → ok $GID" 90 && ok "carol вступила по лимитной ссылке" || bad "carol не вступила"
wait_log "$AL" "v2: группа $GID обновлена .*участников 3" 90 && ok "alice видит carol в составе (журнал)" || bad "alice не видит carol"
PD=$(start_client "$D" dave@local "${V2[@]}" "PARVANE_AUTOGROUPJOIN=$T1")
wait_log "$DL" "AUTOGROUPJOIN (check|join) → отказ" 90 && ok "dave: по исчерпанной ссылке — отказ" || bad "dave: исчерпанная ссылка не отклонена"
grep -qa "AUTOGROUPJOIN join → ok" "$DL" && bad "dave вступил по исчерпанной ссылке" || ok "dave по исчерпанной ссылке не вступил"
stop_pid "$PD"

# ── §2 заявки ────────────────────────────────────────────────────────────────
PD=$(start_client "$D" dave@local "${V2[@]}" "PARVANE_AUTOGROUPJOIN=$T3")
wait_log "$DL" "AUTOGROUPJOIN check → $G members=[0-9]+ request=1" 90 && ok "dave: превью показывает «по одобрению»" || bad "dave: нет request=1 в превью"
wait_log "$DL" "AUTOGROUPJOIN join → pending" 90 && ok "dave подал заявку" || bad "заявка dave не создана"
grep -qa "v2: группа $GID появилась" "$DL" && bad "dave получил группу до одобрения" || ok "до одобрения группы у dave нет"
# владелец онлайн узнаёт о заявке без перезагрузки и без смены версии журнала
wait_log "$AL" "группа $GID обновлена \(v[0-9]+, [^)]*\) .* pending=1" 60 \
  && ok "alice: pending=1 пришёл живым уведомлением" || bad "alice: pending=1 не показан"
stop_pid "$PA"
PA=$(start_client "$A" alice@local "${V2[@]}" "PARVANE_AUTOGROUPREQUEST=$G:list")
wait_log "$AL" "заявки $GID: dave@local:" 60 && ok "список заявок содержит dave" || bad "dave не в заявках"
stop_pid "$PB"
PB=$(start_client "$B" bob@local "${V2[@]}" "PARVANE_AUTOGROUPREQUEST=$G:list")
wait_log "$BL" "заявки $GID: -" 60 && ok "участник без права приглашать заявок не видит" || bad "участник увидел заявки"
stop_pid "$PA"
PA=$(start_client "$A" alice@local "${V2[@]}" "PARVANE_AUTOGROUPREQUEST=$G:approve:dave@local")
wait_log "$AL" "AUTOGROUPREQUEST '$G' approve dave@local → ok" 60 && ok "заявка одобрена (запись AddMember)" || bad "approve не принят"
wait_log "$DL" "v2: группа $GID появилась" 90 && ok "dave видит группу после одобрения" || bad "у dave нет группы"
wait_log "$AL" "v2: группа $GID обновлена .*участников 4" 60 && ok "alice видит dave в составе" || bad "alice не видит dave в составе"
for _ in $(seq 1 30); do group_line "$AL" "$GID" | grep -q "pending=0" && break; sleep 1; done
group_line "$AL" "$GID" | grep -q "pending=0" && ok "alice: pending=0 после одобрения" || bad "alice: pending не обнулился"
# новая эпоха с dave раздаётся владельцем (не чаще раза в 10 с) — bob пишет после неё
sleep 14
stop_pid "$PB"
PB=$(start_client "$B" bob@local "${V2[@]}" "PARVANE_AUTOGROUPSEND=$G:после-одобрения-$S")
wait_log "$DL" "групповое [0-9a-f-]+ в $GID от bob@local: после-одобрения-$S" 90 \
  && ok "dave читает сообщение новой эпохи" || bad "dave не получил сообщение после одобрения"

# отказ: журнал группы не меняется, заявка снята; повторная заявка принимается
VER=$(group_line "$AL" "$GID" | sed -E 's/.*обновлена \(v([0-9]+),.*/\1/')
PE=$(start_client "$E" erin@local "${V2[@]}" "PARVANE_AUTOGROUPJOIN=$T3")
wait_log "$EL" "AUTOGROUPJOIN join → pending" 90 && ok "erin подала заявку" || bad "заявка erin не создана"
stop_pid "$PA"
PA=$(start_client "$A" alice@local "${V2[@]}" "PARVANE_AUTOGROUPREQUEST=$G:decline:erin@local")
wait_log "$AL" "AUTOGROUPREQUEST '$G' decline erin@local → ok" 60 && ok "заявка erin отклонена" || bad "decline не принят"
sleep 3
grep -qa "v2: группа $GID появилась" "$EL" && bad "erin получила группу после отказа" || ok "erin группы не получила"
[ "$(group_line "$AL" "$GID" | sed -E 's/.*обновлена \(v([0-9]+),.*/\1/')" = "$VER" ] \
  && ok "отказ не меняет журнал группы (v$VER)" || bad "версия журнала изменилась после отказа"
stop_pid "$PE"
PE=$(start_client "$E" erin@local "${V2[@]}" "PARVANE_AUTOGROUPJOIN=$T3")
wait_log "$EL" "AUTOGROUPJOIN join → pending" 90 && ok "повторная заявка после отказа принята к рассмотрению" || bad "повторная заявка не создана"
wait_log "$AL" "группа $GID обновлена \(v[0-9]+, [^)]*\) .* pending=1" 60 \
  && ok "alice: повторная заявка видна (pending=1)" || bad "alice: повторная заявка не показана"

# отзыв ссылки: по ней больше не вступить
stop_pid "$PA"
PA=$(start_client "$A" alice@local "${V2[@]}" "PARVANE_AUTOGROUPINVITE=$G:revoke:$T3")
wait_log "$AL" "INVITE revoke .* → ok \(v2\)" 60 && ok "ссылка по одобрению отозвана" || bad "ссылка не отозвана"
stop_pid "$PE"
PE=$(start_client "$E" erin@local "${V2[@]}" "PARVANE_AUTOGROUPJOIN=$T3")
wait_log "$EL" "AUTOGROUPJOIN (check|join) → отказ" 90 && ok "по отозванной ссылке — отказ" || bad "отозванная ссылка не отклонена"

if grep -qaE "запись не открыта|ошибка записи|E2E не удался" "$AL" "$BL" "$CL" "$DL"; then
  bad "в логах есть сбои записей v2"
else
  ok "сбоев записей v2 нет"
fi
for L in "$A" "$B" "$C" "$D" "$E"; do grep -qa 'Fatal' "$L/td/log.txt" && bad "Fatal в $L"; done
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"; stop_pid "$PD"; stop_pid "$PE"; stack_stop
finish "verify_protocol_v2_invites"
