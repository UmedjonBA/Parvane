#!/usr/bin/env bash
# Parvane — e2e звонка между двумя РЕАЛЬНЫМИ экземплярами форка (Э4-b, без звука).
# alice звонит bob (PARVANE_AUTOCALL), bob авто-принимает (PARVANE_AUTOACCEPT).
# Медиа — StubMediaBackend, поэтому проверяем ВЕСЬ путь сигналинга по логам:
# сигналы — запечатанные конверты v2 через gateway; bob получает входящий от
# alice; ОБА доходят до состояния Active. В v2 звонить можно только тому, с кем
# уже была переписка (ключ доступа собеседника) — сначала обмен сообщениями.
# Стек (nats + шарды + gateway) поднимает сам через verify_lib.sh.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-call}"
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"

pair_exchange "$A" alice@local "$B" bob@local
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOACCEPT=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOCALL=bob@local)

# Ждём, пока оба выйдут в Active (или таймаут).
for _ in $(seq 1 60); do
  grep -qa 'звонок → Active' "$AL" 2>/dev/null && grep -qa 'звонок → Active' "$BL" 2>/dev/null && break
  sleep 1
done

grep -qa 'исходящий звонок → bob@local' "$AL" && ok "alice инициировала звонок" || bad "alice не позвонила"
grep -qa 'v2 → bob@local сигнал звонка' "$AL" && ok "сигналы звонка ушли конвертами v2" || bad "нет сигналов звонка по v2"
grep -qa 'ВХОДЯЩИЙ звонок от alice@local' "$BL" && ok "bob получил входящий от alice" || bad "bob не получил входящий"
grep -qa 'звонок → Active' "$AL" && ok "alice → Active" || bad "alice не дошла до Active"
grep -qa 'звонок → Active' "$BL" && ok "bob → Active" || bad "bob не дошёл до Active"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"

stop_pid "$AP"; stop_pid "$BP"; stack_stop
finish "ЗВОНОК e2e"
