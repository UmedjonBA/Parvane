#!/usr/bin/env bash
# Снимки Android для сверки с телефонной версией web (spec 032): те же экраны, что scripts/e2e_web_phone_shots.mjs
# (эталон — local-workdirs/spec032/web-ref*/). После tgx_session_flow.sh (его стек; bob — desktop).
#   1) вход через интерфейс новым ником: стартовый экран, регистрация, ник, пароль (стенд без подтверждения ботом);
#   2) данные: переписка с bob, группа, папка чатов, записи «Плана», заметка — выдуманные;
#   3) экраны: чаты, меню «+», «План» (Сегодня, День, Мес, Год, Список, карточка, настройки), «Здоровье», ввод
#      текстом, «Знания» (заметки, заметка, граф, холст, файлы), «Профиль».
# Проверки — только что экраны открываются и X не падает; сверка — глазами по снимкам.
#   ./tgx_web_parity_shots.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-parity}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
. "$HERE/tgx_ui.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(ls -td /tmp/pv-tgx.* | head -1); B="$SB/bob"
NICK="carol$(date +%s | tail -c 6)"
N=0
shot() { N=$((N + 1)); sleep "${2:-2}"; tgx_shot "$OUT/$(printf '%02d' $N)-$1.png"; }
swipe_up() { a shell input swipe 540 1700 540 "${1:-700}" 400; sleep 1; }

# 1) вход через интерфейс
a shell am force-stop "$TGX_PKG" >/dev/null 2>&1; sleep 1
a shell pm clear "$TGX_PKG" >/dev/null 2>&1
a shell pm grant "$TGX_PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1
a shell rm -f /data/local/tmp/parvane-e2e-cmd /data/local/tmp/parvane-autolink /data/local/tmp/parvane-autologin >/dev/null 2>&1
a reverse "tcp:$PV_GW_WS_PORT" "tcp:$PV_GW_WS_PORT" >/dev/null 2>&1
tgx_put parvane-gateway "ws://127.0.0.1:$PV_GW_WS_PORT/ws"
tgx_start
sleep 8; shot auth-start 1
ui_tap '^(СОЗДАТЬ АККАУНТ|CREATE ACCOUNT)$' 15 && shot auth-register || bad "нет кнопки «Создать аккаунт»"
ui_tap '^(У МЕНЯ УЖЕ ЕСТЬ АККАУНТ|I ALREADY HAVE AN ACCOUNT)$' 10 || a shell input keyevent 4
sleep 2; a shell input text "$NICK"; shot auth-nick 1
ui_tap '^(ДАЛЕЕ|NEXT)$' 10 || bad "нет кнопки «Далее»"
sleep 3; shot auth-password 1
# Нового ника на сервере нет — регистрация (стенд без подтверждения ботом входит сразу)
ui_tap '^(СОЗДАТЬ АККАУНТ|CREATE ACCOUNT)$' 10 || bad "нет «Создать аккаунт» на экране пароля"
sleep 2; a shell input keyevent 61; sleep 1; a shell input text "$PV_PASSWORD"; shot auth-register-filled 1
ui_tap '^(СОЗДАТЬ АККАУНТ|CREATE ACCOUNT)$' 10
tgx_logwait "v2: готов" 90 && ok "регистрация и вход через интерфейс ($NICK)" || bad "регистрация через интерфейс не прошла"
sleep 4

# 2) данные
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=$NICK@local:Привет! Завтра встречаемся у библиотеки в 10?")
wait_log "$B/td/log.txt" "autosend → $NICK@local" 60 || bad "bob не написал"
tgx_logwait "v2 ← входящее msg" 60 || bad "сообщение bob не пришло"
stop_pid "$BP"
tgx_mark; tgx_cmd "{\"op\":\"group_create\",\"title\":\"Книжный клуб\",\"members\":[\"bob@local\"]}"
tgx_mark; tgx_cmd "{\"op\":\"folder\",\"peer\":\"bob@local\",\"title\":\"Друзья\"}"
tgx_mark; tgx_cmd '{"op":"sections","section":"calendar"}'
H=$(( 10#$(date +%H) + 1 )); [ "$H" -gt 22 ] && H=22
for line in "созвон сегодня $H:00 45 мин" "задача сдать отчёт до пт" "пробежка завтра 8:00 30 мин" "обед гречка 150г б30 ж10 у60 520 ккал" \
  "вода 500 мл" "сон 23:40-07:30" "вес 72,4"; do
  tgx_mark; tgx_cmd "{\"op\":\"planner_add\",\"text\":\"$line\"}"
done
tgx_mark; tgx_cmd '{"op":"note_create","title":"Список книг","text":"# Список книг\n\n- [ ] Мастер и Маргарита\n- [x] Пикник на обочине\n\nСм. [[Идеи]] #чтение"}'
tgx_mark; tgx_cmd '{"op":"sections","section":"chats"}'
tgx_stop; tgx_start; tgx_logwait "v2: готов" 90; sleep 5

# 3) экраны (переходы — кнопками панели разделов; «назад» — только чтобы закрыть шторку/меню)
tab() { ui_tap "^($1)\$" 10 || { echo "   нет на экране: $1"; return 1; }; }
# закрыть шторку крестиком либо меню «назад» — только если они открыты (лишнее «назад» уводило из приложения)
close() {
  ui_dump; if [ -n "$(ui_bounds '^(Закрыть|Close)$')" ]; then tab 'Закрыть|Close'
  elif [ -n "$(ui_bounds '^(Запись в план|Plan entry|Отмена|Cancel)$')" ]; then a shell input keyevent 4; sleep 1; fi
}
shot chats
tab 'Новая запись|New entry' && shot chats-plus-menu 1
close
tab 'Поиск|Search' && shot chats-search
close
tab 'Профиль|Profile' && shot profile
swipe_up 300; shot profile-scroll 1
swipe_up 300; shot profile-scroll2 1
tab 'План|Planner' && shot plan-today
swipe_up 600; shot plan-today-scroll 1
for v in "День|Day:week" "Мес|Mon:month" "Год|Year:year" "Список|List:agenda"; do
  tab "${v%%:*}" && shot "plan-${v##*:}"
done
tab 'Сегодня|Today'; sleep 2
tab 'созвон.*' && shot plan-entry
close
tab 'Настройки плана|Planner settings' && shot plan-settings
close
tab 'Здоровье|Health' && shot plan-health
for i in 1 2 3 4; do swipe_up 500; shot "plan-health-$i" 1; done
tab 'Новая запись|New entry' && shot quick 1
a shell input text "lesson%stue%s15:00%severy%sweek"; shot quick-typed 2
close; close
tab 'Знания|Knowledge' && shot knowledge 4
tab 'Список книг' && shot note-open
swipe_up 600; shot note-scroll 1
tab 'Знания|Knowledge'; sleep 2
for t in "Граф|Graph:graph" "Холст|Canvas:canvas" "Файлы|Files:files"; do
  tab "${t%%:*}" && shot "knowledge-${t##*:}" 3
done
tab 'Холст|Canvas'; tab 'Холст из графа|Canvas from graph' && shot knowledge-canvas-from-graph 3
tab 'Чаты|Chats' && shot chats-back
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
echo "снимки: $OUT ($N)"
finish "TGX PARITY SHOTS"
