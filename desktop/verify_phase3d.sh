#!/usr/bin/env bash
# Parvane Фаза 3d — sync при старте (офлайн-бэклог) + список диалогов + периодика.
# Ключевое отличие от 3c: bob шлёт alice сообщение, ПОКА alice ОФЛАЙН (её форк
# остановлен). Push в инбокс уходит в никуда (NATS fire-and-forget), значит
# доставить сообщение может ТОЛЬКО стартовый sync в AfterSessionReady. Проверяем:
#   1) после старта alice входящее всё равно получено (startup sync);
#   2) диалог с отправителем виден в списке чатов (в списке=1);
#   3) периодический sync-таймер запущен;
#   4) без фатальных ошибок.
# До E2E сообщение публиковалось снаружи открытым текстом через `nats pub`; теперь
# отправитель — настоящий клиент, а alice сначала один раз поднимается, чтобы
# опубликовать устройство (без prekeys получателя sealed-отправка невозможна).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-3d}"
SELF="alice@local"
SENDER="bob@local"
TEXT="phase3d-$(date +%s)"
A="$SB/alice"; B="$SB/bob"
TDLOG="$A/td/log.txt"

# 1. alice публикует устройство и уходит офлайн
PA=$(start_client "$A" "$SELF" PARVANE_NO_LINK_OFFER=1)
wait_log "$TDLOG" "E2E-устройство готово" 40 || bad "alice не поднялась"
stop_pid "$PA"

# 2. ОФЛАЙН-отправка bob→alice (alice не запущена)
echo "офлайн-отправка bob→alice (alice остановлена): $TEXT"
PB=$(start_client "$B" "$SENDER" PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="$SELF:$TEXT")
wait_log "$B/td/log.txt" "Parvane: отправлено msg .* \[E2E\]" 40 && ok "bob отправил, пока alice офлайн" || bad "bob не отправил"
sleep 1  # дать шарду сохранить; push уйдёт в никуда
stop_pid "$PB"
grep -qa "$TEXT" "$A/td/"log*.txt 2>/dev/null && bad "alice получила сообщение, будучи офлайн?!" || ok "до старта alice сообщения у неё нет"

# 3. ТЕПЕРЬ запускаем alice — backlog должен подтянуться стартовым sync
PA=$(start_client "$A" "$SELF" PARVANE_NO_LINK_OFFER=1)
wait_log "$TDLOG" "Parvane: входящее msg .* \($SENDER\): $TEXT" 60
wait_log "$TDLOG" "Parvane: диалог $SENDER — в списке=1" 20
# дать таймеру шанс отработать минимум один интервал
sleep 4
stop_pid "$PA"

echo "── приём/диалог/таймер (из log.txt) ──"
grep -aiE "Parvane: (входящее|диалог|инъецировано|периодический|sync ошибка)" "$TDLOG" 2>/dev/null || echo "(нет строк!)"
echo "────────────────────────────"

grep -qa "Parvane: входящее msg .* ($SENDER): $TEXT" "$TDLOG" && ok "офлайн-бэклог получен стартовым sync" || bad "офлайн-сообщение не получено при старте"
grep -qa "Parvane: диалог $SENDER — в списке=1" "$TDLOG" && ok "диалог виден в списке чатов"           || bad "диалог не в списке"
grep -qa "Parvane: периодический sync" "$TDLOG" && ok "периодический sync-таймер запущен"               || bad "периодика не запущена"
grep -qaiE "Fatal|Unexpected in " "$TDLOG" && bad "в логе фатальная ошибка" || ok "без фатальных ошибок"

stack_stop
finish "ФАЗА 3d"
