#!/usr/bin/env bash
# Parvane — inline-ФОТО между двумя реальными экземплярами форка (Фаза 4c).
# alice-форк шлёт настоящий PNG bob-форку; bob принимает его как ФОТО (не
# документ): декодирует картинку и инъецирует MTP_messageMediaPhoto с PhotoData
# из локального изображения. Проверяем:
#   1) alice отправила медиа в шину;
#   2) bob инъецировал ИМЕННО фото (лог "получено фото … WxH"), а не документ;
#   3) размеры картинки распознаны (декодирование прошло);
#   4) без фатальных ошибок.
# Визуальный inline-рендер подтверждается в GUI — headless проверяет контракт.
#
# Требует запущенные nats + identity + messenger + cloud и собранный бинарь.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
NATS="${NATS_BIN:-$HOME/.local/bin/nats}"
A_WD="$(mktemp -d /tmp/pv-ph-alice.XXXXXX)"; B_WD="$(mktemp -d /tmp/pv-ph-bob.XXXXXX)"
A_LOG="$A_WD/td/log.txt"; B_LOG="$B_WD/td/log.txt"
PNG="$A_WD/pic.png"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
"$NATS" --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти шарды"; exit 2; }

# Настоящий PNG 320x240 (без внешних либ).
python3 - "$PNG" <<'PY'
import sys, struct, zlib
w, h = 320, 240
raw = b''
for y in range(h):
    row = b'\x00'
    for x in range(w):
        row += bytes(((x*3) % 256, (y*5) % 256, ((x+y)*2) % 256, 255))
    raw += row
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
png = (b'\x89PNG\r\n\x1a\n'
    + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(raw, 9))
    + chunk(b'IEND', b''))
open(sys.argv[1], 'wb').write(png)
PY
echo "PNG: $(stat -c%s "$PNG") байт (320x240)"

# bob стартует и делает полный ресинк (since=0) — он реплеит СТАРЫЕ фото из
# истории мессенджера. Поэтому изолируемся: даём ресинку осесть, считаем фото-
# строки ДО отправки, потом ждём прироста именно от нашего PNG.
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN='bob@local:test' \
  "$BIN" -workdir "$B_WD/td" >"$B_WD/out.log" 2>&1 &
BPID=$!
sleep 6  # дать стартовому ресинку слить старую историю
BEFORE=$(grep -c "Parvane: получено фото" "$B_LOG" 2>/dev/null || echo 0)

QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN='alice@local:test' \
  PARVANE_AUTOSENDFILE="bob@local:$PNG" "$BIN" -workdir "$A_WD/td" >"$A_WD/out.log" 2>&1 &
APID=$!
# ждём отправку у alice И новую фото-строку у bob (сверх BEFORE).
for i in $(seq 1 30); do
    AFTER=$(grep -c "Parvane: получено фото" "$B_LOG" 2>/dev/null || echo 0)
    [ "$AFTER" -gt "$BEFORE" ] \
        && grep -q "Parvane: медиа отправлено" "$A_LOG" 2>/dev/null && break
    sleep 1
done
sleep 1
kill "$APID" "$BPID" 2>/dev/null; wait "$APID" "$BPID" 2>/dev/null

AFTER=$(grep -c "Parvane: получено фото" "$B_LOG" 2>/dev/null || echo 0)
echo "── BOB (новые фото за прогон: $((AFTER-BEFORE))) ──"
grep "Parvane: получено фото от alice@local" "$B_LOG" 2>/dev/null | tail -1

SENT=$(grep "Parvane: медиа отправлено" "$A_LOG" 2>/dev/null | tail -1)
[ -n "$SENT" ] && ok "alice отправила фото" || bad "alice не отправила"
[ "$AFTER" -gt "$BEFORE" ] && ok "bob инъецировал НОВОЕ фото (photo-путь)" || bad "bob не показал новое фото"
PHOTO_LINE=$(grep "Parvane: получено фото от alice@local" "$B_LOG" 2>/dev/null | tail -1)
echo "$PHOTO_LINE" | grep -q "320x240" && ok "размеры картинки распознаны (320x240)" || bad "размеры не распознаны"
grep -qiE "Fatal|Unexpected in |ошибка скачивания|не записать" "$A_LOG" "$B_LOG" 2>/dev/null \
    && bad "ошибка в логе" || ok "без фатальных ошибок"

rm -rf "$A_WD" "$B_WD"
[ "$RC" -eq 0 ] && printf '\033[32mINLINE-ФОТО: OK\033[0m\n' || printf '\033[31mINLINE-ФОТО: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
