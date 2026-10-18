#!/usr/bin/env bash
# Parvane — e2e ГРУППОВОГО звонка в форке (mesh, без звука). alice создаёт группу v2
# с bob+carol и стартует групповой звонок; bob и carol принимают приглашение
# (PARVANE_AUTOACCEPT — приглашение ждёт «Принять / Отклонить», spec 024). Проверяем,
# что каждый из троих соединён с двумя другими (полный mesh) по логам onPeerState.
# Сигналы — конверты v2 через gateway; ключ доступа участнику общей группы движок
# раздаёт сам (acquirePeerKey, T185). Стек поднимает сам (verify_lib.sh).
# Медиа — StubMediaBackend (без звука). Известный хвост T185: групповой звонок
# упирается в лимит частоты gateway — на desktop через gateway до spec 029 не проверялся.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-group-call}"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"
AL="$A/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
# bob и carol заводят журналы устройств v2 до создания группы (группу v2 создают
# только из участников на v2)
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOACCEPT=1)
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOACCEPT=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
wait_log "$CL" "v2: готов" 90 || bad "carol: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 \
  'PARVANE_AUTOGROUP=ГК:bob@local,carol@local' 'PARVANE_AUTOGROUPCALL=ГК')
GID=""
for _ in $(seq 1 60); do GID=$(group_gid "$AL" "ГК"); [ -n "$GID" ] && break; sleep 1; done
[ -n "$GID" ] && ok "группа v2 создана ($GID)" || bad "группа не создана"
cnt() { local n; n=$(grep -ac 'groupcall .* → Active' "$1" 2>/dev/null); echo "${n:-0}"; }
for _ in $(seq 1 90); do
  [ "$(cnt "$AL")" -ge 2 ] && [ "$(cnt "$BL")" -ge 2 ] && [ "$(cnt "$CL")" -ge 2 ] && break
  sleep 1
done
na=$(cnt "$AL"); nb=$(cnt "$BL"); nc=$(cnt "$CL")
grep -qa 'групповой звонок начат' "$AL" && ok "alice инициировала групповой звонок" || bad "alice не начала"
grep -qa 'v2 → .* сигнал группового звонка' "$AL" && ok "сигналы группового звонка ушли конвертами v2" || bad "нет сигналов группового звонка по v2"
[ "$na" -ge 2 ] && ok "alice соединена с 2 участниками (n=$na)" || bad "alice mesh неполный (n=$na)"
[ "$nb" -ge 2 ] && ok "bob соединён с 2 участниками (n=$nb)" || bad "bob mesh неполный (n=$nb)"
[ "$nc" -ge 2 ] && ok "carol соединена с 2 участниками (n=$nc)" || bad "carol mesh неполный (n=$nc)"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" "$CL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stop_pid "$CP"; stack_stop
finish "ГРУППОВОЙ ЗВОНОК e2e (звук — вживую)"
