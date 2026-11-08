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
# Сетка открывается на подъёме либо на первом деле дня (как web): днём задача на текущий час бывает ниже экрана —
# прокрутить сетку вниз, пока блок не появится
find_down() { local i; for i in 0 1 2 3 4 5 6 7; do has "$1" && return 0; a shell input swipe 540 1800 540 1100 400; sleep 1; done; return 1; }

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
if find_down '^Описание в блоке сетки$'; then ok "описание задачи видно в блоке сетки «День»"; else bad "описания задачи нет в блоке сетки"; fi
tgx_shot "$OUT/01-day-grid.png"
# Полоска «сейчас» поверх блока: в середине блока (по x подписи названия) есть красная строка пикселей
XY=$(ui_bounds '^Сверка сетки$')
if [ -n "$XY" ]; then
  RED=$(python3 - "$OUT/01-day-grid.png" ${XY} <<'EOF'
# Без PIL (на MSI его нет — final9 падал ModuleNotFoundError): PNG screencap — 8 бит RGB/RGBA без чересстрочности
import struct, sys, zlib
data = open(sys.argv[1], "rb").read(); pos = 8; idat = b""
while pos < len(data):
    n, t = struct.unpack(">I4s", data[pos:pos + 8]); body = data[pos + 8:pos + 8 + n]; pos += 12 + n
    if t == b"IHDR": w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
    elif t == b"IDAT": idat += body
assert depth == 8 and ctype in (2, 6), (depth, ctype)
x = int(sys.argv[2]); y0 = int(sys.argv[3]); h = min(h, y0 + 260) # строки ниже окна не нужны
bpp = 4 if ctype == 6 else 3; stride = w * bpp; raw = zlib.decompress(idat); rows = []; prev = bytearray(stride)
for r in range(h):
    f = raw[r * (stride + 1)]; line = bytearray(raw[r * (stride + 1) + 1:(r + 1) * (stride + 1)])
    for i in range(stride):
        a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
        if f == 1: line[i] = (line[i] + a) & 255
        elif f == 2: line[i] = (line[i] + b) & 255
        elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
        elif f == 4:
            pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
            line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    rows.append(line); prev = line
px = lambda y: rows[y][x * bpp:x * bpp + 3]
hits = [y for y in range(max(0, y0 - 40), min(h, y0 + 260))
        if (lambda p: p[0] > 120 and p[0] > 2 * p[1] and p[0] > 2 * p[2])(px(y))]
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
if find_down '^Сверка сетки$'; then ok "«План» без связи показывает записи сразу"; else bad "«План» без связи пуст"; fi
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
find_down '^Сверка сетки$' && ok "«План» после подключения на месте" || bad "«План» после подключения пуст"
tgx_mark
tgx_cmd "{\"op\":\"planner_add\",\"text\":\"Проверка правки после связи\"}"
tgx_logwait "planner_add → ok" 20 >/dev/null && ok "правка «Плана» после подключения проходит" || bad "правка «Плана» после подключения отвергнута"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX OFFLINE SECTIONS"
