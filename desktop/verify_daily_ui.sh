#!/usr/bin/env bash
# Parvane desktop — «ежедневное сломано» (ревью UI 7 ноя 2026, этап 2): штатные кнопки tdesktop ведут в Parvane,
# а не в MTProto. Действия — хуком PARVANE_AUTOUI (тот же вход, что у кнопки: бокс «Новая группа»,
# Calls::Instance, ApiWrap::resolveJumpToDate, меню отправки «без звука», пересылка с «скрыть имя»).
# Без правок каждая проверка падает: бокс слал messages.createChat, звонки — phone.*, переход к дате —
# messages.getHistory, реакций не было, «без звука» не доезжал до получателя, «скрыть имя» игнорировалось.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-daily-ui}"
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"
STAMP=$(date +%s); TODAY=$(date +%F); TOMORROW=$(date -d tomorrow +%F)

pair_exchange "$A" alice@local "$B" bob@local
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOACCEPT=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOUI=reactions:-@2,newgroup:Ежедневная-$STAMP|bob@local@3,newchannel:Новости-$STAMP@5,jumpdate:bob@local|$TODAY@7,jumpdate:bob@local|$TOMORROW@8,addcontact:-@9,mainmenu:-@10,silent:bob@local|тихо-$STAMP@11,forward:bob@local|Ежедневная-$STAMP|preserve@22,forward:bob@local|Ежедневная-$STAMP|noname@25,groupcall:Ежедневная-$STAMP@30")

# п. 4 — реакции
wait_log "$AL" "autoui реакции: 7 \[" 40 && ok "реакции: встроенный набор из 7 (как web)" || bad "набора реакций нет"
grep -aE "autoui реакции: .*быстрая=👍" "$AL" >/dev/null && ok "быстрая реакция по умолчанию 👍" || bad "быстрой реакции нет"
# п. 1 — «Новая группа» / «Новый канал» из бокса
wait_log "$AL" "группа v2 'Ежедневная-$STAMP' создана" 40 && ok "бокс «Новая группа» создал группу v2" || bad "группа из бокса не создана"
wait_log "$AL" "группа v2 'Новости-$STAMP' создана" 40 && ok "бокс «Новый канал» создал канал" || bad "канал из бокса не создан"
GID=$(group_gid "$AL" "Ежедневная-$STAMP")
[ -n "$GID" ] && wait_log "$BL" "группа $GID обновлена" 60 && ok "bob в группе из бокса" || bad "bob не получил группу"
# п. 5 — «Перейти к дате»
wait_log "$AL" "«Перейти к дате» $TODAY → msg [1-9]" 30 && ok "переход к сегодняшней дате — сообщение найдено" || bad "переход к дате не нашёл сообщение"
wait_log "$AL" "autoui jumpdate → msg [1-9]" 30 && ok "колбэк перехода вызван" || bad "колбэк перехода не вызван"
wait_log "$AL" "«Перейти к дате» $TOMORROW → msg [1-9].*позже всех" 30 && ok "дата позже всех — последнее сообщение" || bad "дата позже всех не обработана"
# п. 10 и 11
wait_log "$AL" "«Добавить контакт» → поиск по нику" 30 && ok "«Добавить контакт» — поиск по нику" || bad "«Добавить контакт» открыл телефонный бокс"
wait_log "$AL" "главное меню → «Профиль»" 30 && ok "гамбургер/полоса папок — «Профиль»" || bad "главное меню пустое"
# п. 35 — «Отправить без звука»
wait_log "$BL" "входящее msg .* \(alice@local\): тихо-$STAMP" 60 && ok "bob получил тихое сообщение" || bad "тихое не дошло"
wait_log "$BL" "msg .* без звука \(Content.silent\)" 20 && ok "Content.silent дошёл до получателя" || bad "silent не дошёл"
wait_log "$BL" "уведомление без звука \(silent\)" 20 && ok "у получателя уведомление без звука" || bad "silent не дошёл до уведомления"
# п. 18 — пересылка: с автором и «скрыть имя»
wait_log "$BL" "переслано от «" 60 && ok "пересылка с автором — «переслано от»" || bad "пересланное без автора"
sleep 6
N=$(grep -ac "переслано от «" "$BL"); G=$(grep -ac "групповое .* в $GID от alice@local" "$BL")
[ "$N" -eq 1 ] && [ "$G" -ge 2 ] && ok "«скрыть имя» — копия без автора (пересланных $G, с автором $N)" || bad "«скрыть имя» не соблюдено (пересланных $G, с автором $N)"
# п. 2 — групповой звонок из шапки группы (Calls::Instance::startOrJoinGroupCall)
wait_log "$AL" "групповой звонок из интерфейса → $GID" 60 && ok "групповой звонок — в Parvane" || bad "групповой звонок ушёл в видеочат Telegram"
wait_log "$AL" "групповой звонок начат" 30 && ok "групповой звонок начат" || bad "групповой звонок не начат"
wait_log "$BL" "groupcall .* → Active" 60 && ok "bob в групповом звонке" || bad "bob не соединился"
stop_pid "$AP"; stop_pid "$BP"
# п. 3 — звонок из профиля (тот же вход Calls::Instance::startOutgoingCall)
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOACCEPT=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOUI=call:bob@local@3")
wait_log "$AL" "звонок из интерфейса → bob@local" 40 && ok "«Звонок» профиля — в Parvane" || bad "звонок ушёл в phone.requestCall"
wait_log "$BL" "ВХОДЯЩИЙ звонок от alice@local" 40 && ok "bob получил входящий" || bad "bob не получил входящий"
wait_log "$AL" "звонок → Active" 40 && ok "звонок соединён" || bad "звонок не соединился"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stack_stop
finish "ЕЖЕДНЕВНОЕ UI (этап 2)"
