#!/usr/bin/env bash
# Parvane Фаза 3c — e2e-проверка приёма входящих ОНЛАЙН.
# alice запущена и ждёт; bob (второй форк) шлёт ей сообщение. Ожидаем, что
# push в инбокс alice триггерит приём → расшифровку → инъекцию в Data::Session,
# и в <workdir>/log.txt появляется "Parvane: входящее msg … (bob@local): <text>".
# До E2E сообщение публиковалось снаружи открытым текстом через `nats pub` — после
# ревью безопасности plaintext в msg.chat.send запрещён (P-22), отправитель —
# настоящий клиент.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-3c}"
SELF="alice@local"
SENDER="bob@local"
TEXT="phase3c-$(date +%s)"
A="$SB/alice"; B="$SB/bob"
TDLOG="$A/td/log.txt"

# 1. форк как alice (публикует устройство и остаётся онлайн)
PA=$(start_client "$A" "$SELF" PARVANE_NO_LINK_OFFER=1)
wait_log "$TDLOG" "E2E-устройство готово" 40 || bad "alice не поднялась"

# 2. bob шлёт alice
echo "bob→alice: $TEXT"
PB=$(start_client "$B" "$SENDER" PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="$SELF:$TEXT")

# 3. ждём приёма
wait_log "$TDLOG" "Parvane: входящее msg .* \($SENDER\): $TEXT" 60
sleep 1
stop_pid "$PB"; stop_pid "$PA"

echo "── приём (Parvane, из log.txt) ──"
grep -aiE "Parvane: (сессия|входящее|инъецировано|sync ошибка)" "$TDLOG" 2>/dev/null || echo "(нет строк приёма!)"
echo "── ошибки/варнинги вокруг инъекции ──"
grep -aiE "Critical|Fatal|Unexpected|assert" "$TDLOG" 2>/dev/null | head -5 || true
echo "────────────────────────────"

grep -qa "Parvane: сессия поднята" "$TDLOG" && ok "сессия поднята"                       || bad "сессия не поднялась"
grep -qa "Parvane: входящее msg .* ($SENDER): $TEXT" "$TDLOG" && ok "входящее получено, расшифровано и залогировано" || bad "входящее не получено"
grep -qa "Parvane: инъецировано" "$TDLOG" && ok "сообщение инъецировано в Data::Session" || bad "инъекции не было"
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind<>'encrypted';")
[ "${K:-1}" = "0" ] && ok "на сервере только шифртекст" || bad "на сервере есть не-E2E сообщения: $K"
# процесс не должен был упасть до приёма (лог продолжается после инъекции)
grep -qaiE "Fatal|Unexpected in " "$TDLOG" && bad "в логе фатальная ошибка" || ok "без фатальных ошибок"

stack_stop
finish "ФАЗА 3c"
