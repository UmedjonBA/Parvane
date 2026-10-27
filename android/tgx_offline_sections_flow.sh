#!/usr/bin/env bash
# Разделы без сети и сетка дня (отзыв 28 окт 2026). После tgx_web_parity_shots.sh (его аккаунт с «Планом» и заметками).
#   1) задача на текущий час с описанием: во вкладке «День» описание видно в блоке, полоска «сейчас» — поверх блока;
#   2) перезапуск без связи с сервером (adb reverse снят): «План» и «Знания» сразу показывают сохранённое, а не
#      «Загрузку»; связь вернулась — сессия подключается.
#   ./tgx_offline_sections_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-offline}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
. "$HERE/tgx_ui.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(ls -td /tmp/pv-tgx.* | head -1)
tab() { ui_tap "^($1)\$" 10 >/dev/null || echo "   нет на экране: $1"; }
has() { ui_dump; [ -n "$(ui_bounds "$1")" ]; }

a reverse "tcp:$PV_GW_WS_PORT" "tcp:$PV_GW_WS_PORT" >/dev/null 2>&1
tgx_start; tgx_logwait "v2: готов" 90 >/dev/null || bad "сессия не поднялась"; sleep 3

# 1) задача на текущий час: начало на 30 мин раньше, конец на 30 мин позже (в пределах суток)
read -r TODAY START _END <<<"$(python3 -c '
import datetime as d
n = d.datetime.now(); m = n.hour * 60 + n.minute
s = max(0, min(m - 30, 22 * 60)); e = s + 60
print(n.strftime("%Y-%m-%d"), "%02d:%02d" % divmod(s, 60), "%02d:%02d" % divmod(e, 60))')"
tgx_mark
tgx_cmd "{\"op\":\"planner_op\",\"name\":\"save\",\"args\":{\"kind\":\"task\",\"day\":\"$TODAY\",\"item\":{\"name\":\"Сверка сетки\",\"description\":\"Описание в блоке сетки\",\"day\":\"$TODAY\",\"start\":\"$START\",\"minutes\":60}}}"
tgx_logwait "planner_op → ok" 20 >/dev/null || bad "задача не записана"
tab 'План|Planner'; tab 'День|Day'; sleep 2
if has '^Описание в блоке сетки$'; then ok "описание задачи видно в блоке сетки «День»"; else bad "описания задачи нет в блоке сетки"; fi
tgx_shot "$OUT/01-day-grid.png"
# Полоска «сейчас» поверх блока: в середине блока (по x подписи названия) есть красная строка пикселей
XY=$(ui_bounds '^Сверка сетки$')
if [ -n "$XY" ]; then
  RED=$(python3 - "$OUT/01-day-grid.png" ${XY} <<'EOF'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB"); x = int(sys.argv[2]); y0 = int(sys.argv[3])
hits = [y for y in range(max(0, y0 - 40), min(im.height, y0 + 260))
        if (lambda p: p[0] > 120 and p[0] > 2 * p[1] and p[0] > 2 * p[2])(im.getpixel((x, y)))]
print(len(hits))
EOF
)
  [ "${RED:-0}" -gt 0 ] && ok "полоска «сейчас» поверх блока задачи ($RED px)" || bad "полоска «сейчас» закрыта блоком задачи"
else bad "блок «Сверка сетки» не найден на экране"
fi
tab 'Знания|Knowledge'; sleep 6 # заметки прочитаны, сохранённый вид записан (раз в 2 с)
tab 'Чаты|Chats'; sleep 3

# 2) перезапуск без связи
tgx_stop
a reverse --remove "tcp:$PV_GW_WS_PORT" >/dev/null 2>&1
tgx_start
tgx_logwait "сохранённый вид: «План» есть, облако есть" 40 >/dev/null && ok "сохранённый вид разделов прочитан при запуске" \
  || bad "сохранённого вида разделов нет"
sleep 4
tab 'План|Planner'; sleep 2
if has '^Сверка сетки$'; then ok "«План» без связи показывает записи сразу"; else bad "«План» без связи пуст"; fi
has '^(Загрузка…|Loading…)$' && bad "«План» без связи висит на «Загрузке»"
tgx_shot "$OUT/02-planner-offline.png"
tab 'Знания|Knowledge'; sleep 3
if has '^Список книг$'; then ok "«Знания» без связи показывают заметки"; else bad "«Знания» без связи пусты"; fi
has '^(Загрузка заметок…|Loading notes…)$' && bad "«Знания» без связи висят на «Загрузке заметок»"
tgx_shot "$OUT/03-knowledge-offline.png"
tail -n "+${TGX_MARK:-1}" "$TGX_LOG" | grep -qa "v2: готов" && bad "сессия подключилась — проверка была не без связи"

# связь вернулась
tgx_mark
a reverse "tcp:$PV_GW_WS_PORT" "tcp:$PV_GW_WS_PORT" >/dev/null 2>&1
tgx_logwait "v2: готов" 120 >/dev/null && ok "связь вернулась — сессия подключилась" || bad "после возвращения связи сессия не поднялась"
sleep 3
tab 'План|Planner'; sleep 2
has '^Сверка сетки$' && ok "«План» после подключения на месте" || bad "«План» после подключения пуст"
tgx_mark
tgx_cmd "{\"op\":\"planner_add\",\"text\":\"Проверка правки после связи\"}"
tgx_logwait "planner_add → ok" 20 >/dev/null && ok "правка «Плана» после подключения проходит" || bad "правка «Плана» после подключения отвергнута"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX OFFLINE SECTIONS"
