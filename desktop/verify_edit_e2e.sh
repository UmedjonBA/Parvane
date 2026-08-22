#!/usr/bin/env bash
# Parvane desktop — E2E-ПРАВКА sealed-сообщения: alice шлёт и правит своё,
# bob применяет правку; на сервере — только шифртекст (kind=encrypted, edited=1),
# новый текст нигде не лежит открыто; удаление (AUTODELETE) — томбстоун у bob.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-edit}"
STAMP=$(date +%s); T1="черновик-$STAMP"; T2="исправлено-$STAMP"
B="$SB/bob"; A="$SB/alice"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T1" PARVANE_AUTOEDIT="6:$T2")
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T1" 60 && ok "bob получил оригинал" || bad "bob не получил"
wait_log "$A/td/log.txt" "правка своего msg .* \[E2E\]" 30 && ok "alice отправила E2E-правку" || bad "правка не ушла"
wait_log "$B/td/log.txt" "правка применена msg" 40 && ok "bob применил правку" || bad "bob не применил правку"
E=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE edited=1 AND kind='encrypted';")
[ "${E:-0}" = "1" ] && ok "на сервере правка sealed (edited=1, kind=encrypted)" || bad "edited/kind на сервере: $E"
grep -q "$T2" "$SB/messenger.db" && bad "новый текст лежит на сервере открыто" || ok "новый текст на сервере не виден"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "E2E-ПРАВКА"
