#!/usr/bin/env bash
# Parvane desktop — УСТРОЙСТВО ОТСУТСТВОВАЛО (conformance: SYNC-1, SYNC-2).
# Сценарий, которого не было ни в одном наборе: все прежние e2e гоняли обоих
# клиентов онлайн, поэтому потеря сообщений за курсором не ловилась.
#  1) bob поднимается (регистрирует устройство) и ГАСНЕТ;
#  2) alice шлёт ему, пока его нет;
#  3) bob поднимается снова и ОБЯЗАН получить всё пропущенное;
#  4) состояние движка v2 (позиция инбокса) сохранено на диске, неоткрытых
#     записей инбокса нет.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-offline-dev}"
STAMP=$(date +%s); T1="офлайн-1-$STAMP"; T2="офлайн-2-$STAMP"
A="$SB/alice"; B="$SB/bob"

# 1. bob регистрируется и гаснет.
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "v2: готов" 90 && ok "bob зарегистрировал устройство" || bad "bob не поднялся"
stop_pid "$PB"
sleep 2

# 2. alice шлёт, пока bob выключен (два сообщения — двумя запусками).
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T1")
wait_log "$A/td/log.txt" "v2 → bob@local msg" 90 || bad "alice не отправила (1/2)"
sleep 2
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T2")
wait_log "$A/td/log.txt" "v2 → bob@local msg" 90 || bad "alice не отправила (2/2)"
sleep 2
stop_pid "$PA"

# 3. bob возвращается — обязан догнать ОБА сообщения.
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T1" 90 \
	&& ok "bob догнал сообщение, присланное в его отсутствие (1/2)" \
	|| bad "ПОТЕРЯ: первое сообщение не доехало после возвращения"
wait_log "$B/td/log.txt" "входящее msg .* \(alice@local\): $T2" 60 \
	&& ok "bob догнал сообщение, присланное в его отсутствие (2/2)" \
	|| bad "ПОТЕРЯ: второе сообщение не доехало после возвращения"

# 4. Позицию инбокса держит движок v2; его состояние сохраняется ДО подтверждения
#    записи серверу (msg.inbox.ack) — иначе после рестарта прочитанное потерялось бы.
sleep 3
[ -s "$B/td/tdata/parvane-v2-bob@local/state" ] \
	&& ok "состояние движка v2 сохранено (позиция инбокса)" \
	|| bad "состояние движка v2 не сохранено"
grep -qE "запись не открыта|ошибка записи" "$B/td/log.txt" && bad "были неоткрытые записи инбокса v2" \
	|| ok "неоткрытых записей инбокса нет"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка в логе" \
	|| ok "без фатальных ошибок"

stop_pid "$PB"; stack_stop
finish "УСТРОЙСТВО ОТСУТСТВОВАЛО"
