#!/usr/bin/env bash
# Админка групп v2: alice(owner) через КЛИЕНТ (хук AUTOADMIN — тот же путь, что
# экраны управления) промоутит bob в админы, добавляет carol, удаляет carol. Все
# действия — записи журнала группы; состояние сверяется по журналу участника bob
# (его роль, число участников), carol поднимается заранее (в группу v2
# добавляется только пользователь с журналом устройств v2).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-gadmin}"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"
AL="$A/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
GNAME="АдминГруппа"

BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
wait_log "$CL" "v2: готов" 90 || bad "carol: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOGROUP=$GNAME:bob@local" \
  "PARVANE_AUTOADMIN=$GNAME;admin:bob@local;add:carol@local;remove:carol@local")

GID=""
for _ in $(seq 1 60); do GID=$(group_gid "$AL" "$GNAME"); [ -n "$GID" ] && break; sleep 1; done
# Ждём последнее действие (remove carol) — стаггер до ~17с + сеть.
wait_log "$AL" "админ-действие 'remove' над carol@local" 60
sleep 3 # bob дочитывает журнал группы после последней записи
echo "── alice AUTOADMIN лог ──"; grep -aE "Parvane: (AUTOADMIN|админ-действие)" "$AL" 2>/dev/null | head

[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"
grep -qa "админ-действие 'admin' над bob@local в .* → ok" "$AL" && ok "клиент: промоут bob→admin ok" || bad "промоут не сработал"
grep -qa "админ-действие 'add' над carol@local в .* → ok" "$AL" && ok "клиент: добавление carol ok" || bad "add не сработал"
grep -qa "админ-действие 'remove' над carol@local в .* → ok" "$AL" && ok "клиент: удаление carol ok" || bad "remove не сработал"
# Состояние — по журналу группы глазами bob: он админ, участников снова двое
group_line "$BL" "$GID" | grep -q "role=admin" && ok "журнал группы у bob: bob = admin" \
  || bad "bob не admin ($(group_line "$BL" "$GID" | grep -o 'role=[a-z]*'))"
grep -a "v2: группа $GID обновлена" "$BL" | grep -q "участников 3" && ok "журнал группы у bob: carol была добавлена" \
  || bad "bob не видел добавления carol"
grep -a "v2: группа $GID обновлена" "$BL" | tail -1 | grep -q "участников 2" && ok "журнал группы у bob: carol удалена" \
  || bad "carol всё ещё в группе по журналу bob"
grep -qa "группа $GID снята" "$CL" && ok "carol: группа снята после исключения" || bad "carol: группа не снята"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" "$CL" && bad "фатальная ошибка" || ok "без фатальных ошибок"

stop_pid "$AP"; stop_pid "$BP"; stop_pid "$CP"; stack_stop
finish "АДМИНКА ГРУПП"
