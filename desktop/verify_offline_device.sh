#!/usr/bin/env bash
# Parvane desktop — УСТРОЙСТВО ОТСУТСТВОВАЛО (conformance: SYNC-1, SYNC-2).
# Сценарий, которого не было ни в одном наборе: все прежние e2e гоняли обоих
# клиентов онлайн, поэтому потеря сообщений за курсором не ловилась.
#  1) bob поднимается (регистрирует устройство) и ГАСНЕТ;
#  2) alice шлёт ему, пока его нет;
#  3) bob поднимается снова и ОБЯЗАН получить всё пропущенное;
#  4) дисковый курсор не должен уезжать за нерасшифрованное:
#     tdata/parvane-pending.txt пуст либо отсутствует при чистом проходе.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-offline-dev}"
STAMP=$(date +%s); T1="офлайн-1-$STAMP"; T2="офлайн-2-$STAMP"
A="$SB/alice"; B="$SB/bob"

# 1. bob регистрируется и гаснет.
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 60 && ok "bob зарегистрировал устройство" || bad "bob не поднялся"
stop_pid "$PB"
sleep 2

# 2. alice шлёт, пока bob выключен (два сообщения — двумя запусками).
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T1")
wait_log "$A/td/log.txt" "E2E-устройство готово" 60 || bad "alice не поднялась"
sleep 6
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T2")
sleep 8
stop_pid "$PA"

# 3. bob возвращается — обязан догнать ОБА сообщения.
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T1" 90 \
	&& ok "bob догнал сообщение, присланное в его отсутствие (1/2)" \
	|| bad "ПОТЕРЯ: первое сообщение не доехало после возвращения"
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T2" 60 \
	&& ok "bob догнал сообщение, присланное в его отсутствие (2/2)" \
	|| bad "ПОТЕРЯ: второе сообщение не доехало после возвращения"

# 4. Курсор и очередь починки согласованы: пропущенного нет.
sleep 3
PEND="$B/td/tdata/parvane-pending.txt"
if [ ! -s "$PEND" ]; then
	ok "очередь починки пуста (всё прочитано)"
else
	bad "остались непрочитанные: $(wc -l < "$PEND") — см. $PEND"
fi
[ -s "$B/td/tdata/parvane-cursors.txt" ] \
	&& ok "дисковый курсор записан после успешной вставки" \
	|| bad "дисковый курсор не записан"
grep -q "НЕ расшифровано" "$B/td/log.txt" && bad "были нерасшифрованные сообщения" \
	|| ok "нерасшифрованных нет"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка в логе" \
	|| ok "без фатальных ошибок"

stop_pid "$PB"; stack_stop
finish "УСТРОЙСТВО ОТСУТСТВОВАЛО"
