#!/usr/bin/env bash
# Parvane desktop — CONTACT-1 (ревью 7 ноя, этап 4): своё имя и заметка контакта через вид `contacts` журнала
# личного состояния. Вход — тот же, что у родного бокса «Новый контакт» / «Изменить» (Parvane::SetContact),
# хук PARVANE_AUTOUI contactset/contactdel/contactshow. Проверки:
#  • alice1 добавляет bob в контакты со своим именем и заметкой → у alice1 своё имя, флаг контакта, заметка;
#  • alice2 (второе устройство) получает то же из журнала ≤ 10 с;
#  • пересылка сообщения bob у получателя — с именем, заданным самим bob (своё имя в провод не уходит);
#  • удаление контакта стирает имя и заметку на обоих устройствах; в БД сервера открытого имени нет.
# Без правки: бокс слал contacts.addContact (MTProto-заглушка), ни имени, ни журнала не было.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-contacts"
stack_start "$SB"
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOSEND_V2=bob@local:знакомство-$S")
wait_log "$L1" "v2: готов" 90 || bad "alice1: v2 не поднялся"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): знакомство-$S" 60 || bad "bob не получил текст alice1"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:ответ-$S")
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): ответ-$S" 90 && ok "alice1 получила ответ bob" || bad "нет ответа bob"
P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1)
wait_log "$L2" "v2: устройство привязано грантом линковки" 150 && ok "alice2 привязана" || bad "alice2 не привязана"
wait_log "$L2" "журнал личного состояния подключён" 90 || bad "alice2: журнал состояния не подключён"
stop_pid "$P1"; stop_pid "$P2"

P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOUI=contactset:bob@local|Роберт|Тестов|сосед по даче@20,contactshow:bob@local@24,forward:bob@local|bob@local|preserve@28,contactdel:bob@local@55,contactshow:bob@local@58")
P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOUI=contactshow:bob@local@40,contactshow:bob@local@75")
wait_log "$L1" "журнал личного состояния подключён" 90 || bad "alice1: журнал не подключён"
wait_log "$L1" "контакт bob@local сохранён \(своё имя «Роберт Тестов», заметка 13 симв.\)" 60 \
  && ok "alice1: контакт сохранён своим именем и заметкой" || bad "alice1: контакт не сохранён"
wait_log "$L1" "autoui контакт bob@local: имя=«Роберт Тестов» контакт=1 заметка=«сосед по даче»" 20 \
  && ok "alice1: родной пользователь — своё имя, контакт, заметка" || bad "alice1: имя/флаг/заметка не применены"
wait_log "$L2" "журнал состояния → контакты \(1 изменений" 60 \
  && ok "alice2: контакт пришёл из журнала" || bad "alice2: контакт из журнала не пришёл"
wait_log "$L2" "autoui контакт bob@local: имя=«Роберт Тестов» контакт=1 заметка=«сосед по даче»" 30 \
  && ok "alice2: своё имя и заметка как на alice1" || bad "alice2: имя/заметка не совпали"
wait_log "$BL" "переслано от «" 60 && ok "bob получил пересланное" || bad "пересылка не дошла"
grep -aq "переслано от «Роберт" "$BL" && bad "своё имя контакта ушло в провод (заголовок пересылки)" \
  || ok "в заголовке пересылки — имя, заданное самим bob (п. 4)"
wait_log "$L1" "контакт bob@local удалён \(имя и заметка стёрты\)" 60 && ok "alice1: контакт удалён" || bad "alice1: не удалён"
wait_log "$L1" "autoui контакт bob@local: имя=«[^Р»][^»]*» контакт=0 заметка=«»" 20 \
  && ok "alice1: после удаления — имя собеседника, не контакт" || bad "alice1: имя/флаг после удаления неверны"
wait_log "$L2" "autoui контакт bob@local: имя=«[^Р»][^»]*» контакт=0 заметка=«»" 60 \
  && ok "alice2: удаление пришло из журнала" || bad "alice2: удаление не пришло"
grep -aq "Роберт" "$SB"/messenger.db* "$SB"/identity.db* 2>/dev/null && bad "своё имя контакта открытым текстом на сервере" \
  || ok "на сервере своего имени контакта открытым текстом нет"
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"; stack_stop
finish "CONTACT-1 (контакты)"
