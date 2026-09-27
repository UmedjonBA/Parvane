#!/usr/bin/env bash
# spec 005 / история 1 в эмуляторе: стикеры, кастом-эмодзи, паки (PACK-1/EMOJI-1) в форке X.
# Запускать ПОСЛЕ tgx_link_e2e.sh (стек в последнем /tmp/pv-tgx.*, X = второе
# устройство alice, bob — desktop).
#   1. bob-desktop шлёт стикер из локального пака TestPack (PARVANE_AUTOSTICKER)
#      → X: «стикер … пак=TestPack», сообщение в чате;
#   2. X открывает чат → панель стикеров (вкладка Stickers) → первый стикер
#      встроенного пака → desktop bob: «входящее медиа … kind=sticker»;
#   3. bob-desktop шлёт текст с кастом-эмодзи из пака TestEmoji (PARVANE_AUTOEMOJI)
#      → X: «пак TestEmoji получен», при отрисовке «эмодзи <docId> → TestEmoji/…»,
#      docId совпадает с формулой EMOJI-1 (desktop считает так же);
#   4. без крашей.
# GIF в эмуляторе не гоняется (у desktop нет хука отправки gif) — маппинг покрыт JVM-тестом.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/../desktop/verify_lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/tgx_ui.sh" # ROOT после verify_lib.sh указывает на desktop/ (verify_paths.sh)
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -qE \"$1\"; do sleep 3; done"; }
OUT=/tmp/pv-tgx-stickers; mkdir -p "$OUT"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s)
A="$SB/alice"; B="$SB/bob"
[ "$(ad shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор жив" || { bad "эмулятора нет — сначала tgx_link_e2e.sh"; finish "TGX STICKERS"; }
ad logcat -c

# тестовые паки для desktop: 3 PNG-стикера и 2 PNG-эмодзи (имена NN-<hex>.png → alt-эмодзи)
PACKS="$OUT/packs-$STAMP"; EMOJI="$OUT/emoji-$STAMP"; mkdir -p "$PACKS/TestPack" "$EMOJI/TestEmoji" "$OUT/no-emoji"
python3 - "$PACKS/TestPack" "$EMOJI/TestEmoji" <<'EOF'
import struct, sys, zlib
def png(path, w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
for i, name in enumerate(['00-1f600.png', '01-1f602.png', '02-1f60d.png']): png(f'{sys.argv[1]}/{name}', 96, 96, (200, 60 + i * 50, 60))
for i, name in enumerate(['00-1f600.png', '01-2728.png']): png(f'{sys.argv[2]}/{name}', 64, 64, (60, 60, 200))
EOF
DOC_EXPECTED=$(python3 -c "
h=1469598103934665603
for b in b'pvemoji:TestEmoji|01-2728.png':
    h ^= b; h = (h * 1099511628211) & 0xFFFFFFFFFFFFFFFF
print(h - (1<<64) if h >= (1<<63) else h)")

# 1. стикер desktop → X
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
# PARVANE_EMOJI_DIR в пустой каталог: у текущего бинарника autosticker берёт первый непустой набор по id,
# и эмодзи-набор из ~/.local/share/ParvaneEmoji прошлых прогонов обгонял TestPack (исправлено в коде,
# вступит после перелинковки десктопа)
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_STICKERS_DIR="$PACKS" PARVANE_EMOJI_DIR="$OUT/no-emoji" PARVANE_AUTOSTICKER="alice@local")
wait_log "$B/td/log.txt" "E2E-устройство готово" 60 || bad "bob не поднялся"
wait_log "$B/td/log.txt" "пак «TestPack» загружен в cloud" 60 && ok "bob: пак загружен в cloud (PACK-1)" || bad "bob: пак не загружен"
xlog "стикер [0-9a-f-]{36} image/png [0-9]+x[0-9]+ пак=TestPack" 90 && ok "X: стикер принят с pack_ref" || bad "X: стикер не принят"
xlog "сообщение [0-9a-f-]{36} → чат [0-9-]+ \(вх\)" 30 && ok "X: сообщение со стикером в чате" || bad "X: сообщение не показано"
sleep 3; ad exec-out screencap -p > "$OUT/01-list.png"

# 2. X → desktop: стикер из встроенного пака через панель
ui_reset; ad shell input tap 540 330; sleep 4; ad exec-out screencap -p > "$OUT/02-chat.png"
xlog "→ X UpdateNewChat|UpdateChatLastMessage" 5 >/dev/null
# кнопка эмодзи слева от поля ввода → панель; вкладка стикеров по описанию
ui_tap 'btn_emoji|Emoji|Эмодзи' 5 || ad shell input tap 72 2208
sleep 2; ad exec-out screencap -p > "$OUT/03-panel.png"
# ряд категорий панели X (1080×2400): часы, смайлы, животные, еда, транспорт, лампа, флаг, СТИКЕРЫ (крайняя правая)
ui_tap 'Stickers|Стикеры|btn_stickers' 3 || ad shell input tap 1006 1430
sleep 3; ad exec-out screencap -p > "$OUT/04-stickers.png"
# первый стикер сетки: под заголовком набора (левая колонка)
# первая ячейка сетки под рядом вкладок панели (y>1500): fallback 135,1560 попадал между заголовком
# набора и первым рядом (04/05-*.png идентичны), а первый StickerSmallView дерева мог быть со скрытой страницы
ui_dump; XY=$(python3 - "$UI_XML" <<'PY'
import re, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
for n in root.iter('node'):
    if 'StickerSmallView' not in n.get('class', ''): continue
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds', ''))
    if not m: continue
    x1, y1, x2, y2 = map(int, m.groups())
    if y1 > 1500 and x2 - x1 >= 40 and y2 - y1 >= 40: print((x1+x2)//2, (y1+y2)//2); break
PY
)
ad shell input tap ${XY:-108 1692}
sleep 5; ad exec-out screencap -p > "$OUT/05-after-tap.png"
xlog "стикер отправлен [0-9a-f-]{36} pack=builtin" 30 && ok "X: стикер из встроенного пака отправлен" || bad "X: стикер не отправлен (см. $OUT/04-stickers.png)"
wait_log "$B/td/log.txt" "входящее медиа [0-9a-f-]{36} \(alice@local, kind=sticker\)" 60 && ok "desktop bob: стикер из X принят (kind=sticker)" || bad "desktop bob: стикер из X не принят"

# 3. кастом-эмодзи desktop → X (EMOJI-1)
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_EMOJI_DIR="$EMOJI" PARVANE_AUTOSEND="alice@local:emoji-ping-$STAMP" PARVANE_AUTOEMOJI="alice@local:TestEmoji:01-2728.png")
wait_log "$B/td/log.txt" "эмодзи-пак «TestEmoji» загружен" 60 && ok "bob: эмодзи-пак загружен" || bad "bob: эмодзи-пак не загружен"
xlog "пак TestEmoji получен" 90 && ok "X: emoji_packs зарегистрирован" || bad "X: пак эмодзи не зарегистрирован"
ui_reset; ad shell input tap 540 330; sleep 5; ad exec-out screencap -p > "$OUT/06-emoji-chat.png"
xlog "эмодзи $DOC_EXPECTED → TestEmoji/01-2728.png" 60 && ok "X: кастом-эмодзи разрешён, docId по EMOJI-1 ($DOC_EXPECTED)" || bad "X: эмодзи $DOC_EXPECTED не разрешён"

ad logcat -d -v time > "$OUT/logcat.txt"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "X без крашей"
ui_reset
stop_pid "$BP"
echo "STICKERS_E2E_DONE rc=$RC"
finish "TGX STICKERS"
