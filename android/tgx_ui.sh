#!/usr/bin/env bash
# Помощники для тапов по UI Telegram X в эмуляторе по дереву uiautomator (а не
# по угаданным координатам). Сорсить после verify_lib.sh. Экран 1080×2400.
#   ui_dump                      — снять дерево в $UI_XML
#   ui_bounds '<regex>'          — центр первого узла, чей text/content-desc/resource-id
#                                  совпадает с regex → "x y" (пусто — нет)
#   ui_tap '<regex>' [ждать сек] — тап по узлу (с повторным снятием дерева до N сек)
#   ui_tap_nth '<class-regex>' N — тап по N-му (0..) узлу класса (например, первый стикер в сетке)
#   ui_in_chat                   — 0, если открыт чат (msg_input в дереве)
#   ui_close_panel               — закрыть панель эмодзи/стикеров, оставшись в чате
#   x_force_stop                 — force-stop X и дождаться смерти процесса (иначе `logcat -c`
#                                  стирал «сессия поднята» живого процесса — ложный «X не поднял сессию»)
UI_XML="${UI_XML:-/tmp/pv-ui.xml}"
ui_dump() {
  timeout 25 adb shell uiautomator dump /sdcard/pv-ui.xml >/dev/null 2>&1 || return 1
  timeout 25 adb pull /sdcard/pv-ui.xml "$UI_XML" >/dev/null 2>&1
}
ui_bounds() {
  python3 - "$UI_XML" "$1" <<'EOF'
import re, sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(0)
rx = re.compile(sys.argv[2], re.I)
for n in root.iter('node'):
    # каждое поле отдельно — иначе якоря ^…$ не срабатывали на склейке «text | desc | id» (27 сен 2026)
    if any(rx.search(n.get(k, '')) for k in ('text', 'content-desc', 'resource-id')):
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds', ''))
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2); break
EOF
}
ui_tap() {
  local rx="$1" secs="${2:-10}" xy=""
  for _ in $(seq 1 "$secs"); do
    ui_dump; xy=$(ui_bounds "$rx")
    [ -n "$xy" ] && break; sleep 1
  done
  [ -n "$xy" ] || return 1
  # shellcheck disable=SC2086
  timeout 25 adb shell input tap $xy; sleep 1
}
ui_tap_nth() {
  local rx="$1" n="${2:-0}"
  ui_dump || return 1
  local xy
  xy=$(python3 - "$UI_XML" "$rx" "$n" <<'EOF'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot(); rx = re.compile(sys.argv[2]); n = int(sys.argv[3]); i = 0
for node in root.iter('node'):
    if rx.search(node.get('class', '')):
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
        if not m: continue
        x1, y1, x2, y2 = map(int, m.groups())
        if x2 - x1 < 40 or y2 - y1 < 40: continue
        if i == n: print((x1 + x2) // 2, (y1 + y2) // 2); break
        i += 1
EOF
)
  [ -n "$xy" ] || return 1
  # shellcheck disable=SC2086
  timeout 25 adb shell input tap $xy; sleep 1
}
# Привести X к списку чатов: закрыть меню/диалоги и вернуться назад (до трёх раз),
# затем убедиться, что активность на переднем плане. Звать в начале сценария и
# перед «тапом по первому чату» (540,330) — иначе тап попадает в сообщение
# открытого чата и открывает контекстное меню (27 сен 2026).
ui_reset() {
  for _ in 1 2 3; do timeout 25 adb shell input keyevent 4; sleep 1; done
  timeout 25 adb shell am start -n org.parvane.tgx/org.thunderdog.challegram.MainActivity >/dev/null 2>&1; sleep 2
}
# Панель эмодзи/стикеров X помнит состояние и восстанавливает её при повторном входе в чат
# (после tgx_stickers_flow.sh опросы тапали по стикерам вместо скрепки, 27 сен 2026). Bounds
# нижней панели в дампе ненадёжны (анимация/translation: y 2145–2146), поэтому без геометрии:
# один back — если панель была открыта, он её закрывает и мы остаёмся в чате (msg_input в
# дереве); если нет — back вышел из чата, открываем первый чат заново (панель уже не восстановится).
ui_in_chat() {
  ui_dump || return 1
  grep -q 'id/msg_input' "$UI_XML"
}
ui_close_panel() {
  timeout 25 adb shell input keyevent 4; sleep 2
  if ! ui_in_chat; then timeout 25 adb shell input tap 540 330; sleep 4; fi
}
# После `am force-stop` процесс X может пережить паузу в 2 с (или подняться заново службой X до
# `logcat -c`): маркеры старта попадали в стёртый буфер (tgx_conformance_flow.sh, 27 сен 2026).
x_force_stop() {
  local pkg="${1:-org.parvane.tgx}"
  for _ in $(seq 1 10); do
    timeout 25 adb shell am force-stop "$pkg"
    sleep 1
    [ -z "$(timeout 25 adb shell pidof "$pkg" 2>/dev/null | tr -d '\r')" ] && return 0
  done
  return 1
}
