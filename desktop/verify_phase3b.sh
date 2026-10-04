#!/usr/bin/env bash
# Parvane Фаза 3b — e2e-проверка врезки отправки.
# Поднимает подписчика на msg.chat.send (NATS за gateway), запускает форк
# headless с PARVANE_AUTOLOGIN + PARVANE_AUTOSEND (синтетическая отправка после
# готовности сессии), затем проверяет:
#   1) лог форка содержит "autosend" и "Parvane: отправлено … [E2E]" (путь публикации);
#   2) подписчик поймал событие msg.chat.send с нужным адресатом;
#   3) на проводе — E2E-конверт: kind=encrypted, sealed (from пуст), текста нет.
# До E2E сценарий искал текст в событии открытым; теперь открытый текст в шине
# был бы дефектом (gateway такой msg.chat.send отвергает, P-22).
set -u
# Сценарий проверяет провод и хранилище ПРЕЖНЕГО протокола (Olm, msg.chat.send,
# таблица messages) — закреплён за v1; путь v2 покрывают verify_protocol_v2*.sh.
PV_PROTO=v1
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-3b}"
URL="nats://127.0.0.1:4222"
SUBLOG="$SB/sub.log"
SELF="alice@local"
PEER="bob@local"
TEXT="phase3b-$(date +%s)"
A="$SB/alice"; B="$SB/bob"

# получатель публикует устройство: sealed-конверт шифруется под его prekeys
PB=$(start_client "$B" "$PEER" PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
stop_pid "$PB"

# 1. подписчик на msg.chat.send
nats --server "$URL" sub msg.chat.send >"$SUBLOG" 2>&1 &
SUBPID=$!
sleep 1

# 2. запуск форка headless: логин + автосенд.
# ВАЖНО: tdesktop пишет LOG() в <workdir>/log.txt, а НЕ в stdout — проверяем его.
TDLOG="$A/td/log.txt"
PA=$(start_client "$A" "$SELF" PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="$PEER:$TEXT")
wait_log "$TDLOG" "Parvane: отправлено msg" 40
wait_log "$SUBLOG" "\"to\":\"$PEER\"" 10
stop_pid "$PA"
kill "$SUBPID" 2>/dev/null; wait "$SUBPID" 2>/dev/null

echo "── лог форка (Parvane, из log.txt) ──"
grep -aE "Parvane: (login|сессия|autosend|отправлено)" "$TDLOG" 2>/dev/null || echo "(нет строк Parvane!)"
echo "── подписчик msg.chat.send ──"
cut -c1-300 "$SUBLOG"
echo "────────────────────────────"

grep -qa "Parvane: login OK"  "$TDLOG" && ok "логин прошёл"            || bad "логин не прошёл"
grep -qa "Parvane: сессия поднята" "$TDLOG" && ok "сессия поднята"     || bad "сессия не поднялась"
grep -qa "Parvane: autosend"  "$TDLOG" && ok "autosend-хук сработал"   || bad "autosend-хук не сработал"
grep -qa "Parvane: отправлено msg .* \[E2E\]" "$TDLOG" && ok "публикация выполнена [E2E]" || bad "публикации [E2E] в логе нет"
grep -qa "\"to\":\"$PEER\"" "$SUBLOG" && ok "msg.chat.send пойман подписчиком, адресат = $PEER" || bad "событие msg.chat.send не поймано"
grep -qa '"kind":"encrypted"' "$SUBLOG" && ok "на проводе E2E-конверт (kind=encrypted)" || bad "на проводе нет kind=encrypted"
grep -qa '"from":""' "$SUBLOG" && ok "sealed sender: from на проводе пуст" || bad "from на проводе не пуст"
grep -qa "$TEXT" "$SUBLOG" && bad "ТЕКСТ сообщения виден в шине открытым" || ok "текста сообщения в шине нет"

stack_stop
finish "ФАЗА 3b"
