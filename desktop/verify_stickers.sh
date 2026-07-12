#!/usr/bin/env bash
# Parvane — e2e стикеров двумя реальными экземплярами (alice → bob).
#   1) alice грузит локальный стикер-пак (PARVANE_STICKERS_DIR) → панель;
#   2) alice шлёт первый стикер (PARVANE_AUTOSTICKER, нативный
#      SendExistingDocument → MirrorOutgoingSticker → E2E-блоб в cloud);
#   3) bob получает kind=sticker → скачивание → нативный рендер стикером;
#   4) без фатальных ошибок.
# Пользователи: A_USER/B_USER (default alice/bob@local, пароль test).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
A_USER="${A_USER:-alice@local}"
B_USER="${B_USER:-bob@local}"
A_WORK="$(mktemp -d /tmp/parvane-stk-alice.XXXXXX)"
B_WORK="$(mktemp -d /tmp/parvane-stk-bob.XXXXXX)"
A_LOG="$A_WORK/td/log.txt"
B_LOG="$B_WORK/td/log.txt"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
nats --server "$URL" req identity.token.issue "{\"user\":\"$A_USER\",\"password\":\"test\"}" \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти шарды"; exit 2; }

# Тестовый пак: 3 PNG-стикера генерируются на лету.
PACKS="$A_WORK/packs"
mkdir -p "$PACKS/TestPack"
python3 - "$PACKS/TestPack" <<'EOF'
import struct, sys, zlib
def write_png(path, w, h, rgb):
    raw = bytearray()
    for y in range(h):
        raw.append(0); raw += rgb[y*w*3:(y+1)*w*3]
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    png = (b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))
    open(path, 'wb').write(png)
d = sys.argv[1]; W = H = 128
for name, cond, col in [
    ("01-circle", lambda x, y: (x-64)**2 + (y-64)**2 < 55**2, (220, 60, 60)),
    ("02-diamond", lambda x, y: abs(x-64) + abs(y-64) < 58, (60, 180, 80)),
    ("03-square", lambda x, y: 12 < x < 116 and 12 < y < 116, (70, 100, 220)),
]:
    rgb = bytearray()
    for y in range(H):
        for x in range(W):
            rgb += bytes(col if cond(x, y) else (255, 255, 255))
    write_png(f"{d}/{name}.png", W, H, rgb)
EOF

echo "alice workdir: $A_WORK"
echo "bob   workdir: $B_WORK"

# bob первым (prekeys ДО отправки ему — см. verify_two_instances.sh).
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$B_USER:test" \
  "$BIN" -workdir "$B_WORK/td" >"$B_WORK/stdout.log" 2>&1 &
B_PID=$!
for i in $(seq 1 30); do
    grep -q "Parvane: E2E-устройство готово" "$B_LOG" 2>/dev/null && break
    sleep 1
done
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_STICKERS_DIR="$PACKS" \
  PARVANE_AUTOLOGIN="$A_USER:test" PARVANE_AUTOSTICKER="$B_USER" \
  "$BIN" -workdir "$A_WORK/td" >"$A_WORK/stdout.log" 2>&1 &
A_PID=$!

# Ждём: bob получил и скачал стикер.
for i in $(seq 1 45); do
    grep -qE "Parvane: (входящее|получено) медиа .*kind=sticker" "$B_LOG" 2>/dev/null && break
    sleep 1
done
sleep 3
kill "$A_PID" "$B_PID" 2>/dev/null; wait "$A_PID" "$B_PID" 2>/dev/null

echo "── ALICE log.txt (stickers) ──"
grep -iE "Parvane: (стикер|autosticker|sticker)" "$A_LOG" 2>/dev/null || echo "(пусто)"
echo "── BOB log.txt (stickers) ──"
grep -iE "Parvane: .*(sticker|стикер|медиа)" "$B_LOG" 2>/dev/null | tail -6 || echo "(пусто)"
echo "──────────────────────────────"

grep -q "Parvane: стикер-пак «TestPack» загружен (3 шт)" "$A_LOG" && ok "alice: пак загружен в панель"   || bad "alice: пак не загружен"
grep -q "Parvane: autosticker → $B_USER" "$A_LOG"                 && ok "alice: autosticker сработал"     || bad "alice: autosticker не сработал"
grep -q "Parvane: sticker отправлен → $B_USER" "$A_LOG"           && ok "alice: стикер ушёл в шину [E2E]" || bad "alice: стикер не отправлен"
grep -qE "kind=sticker.*→ скачивание" "$B_LOG"                    && ok "bob: стикер принят → скачивание" || bad "bob: стикер не принят"
grep -q "Parvane: получено медиа" "$B_LOG"                        && ok "bob: стикер скачан и инъецирован" || bad "bob: стикер не инъецирован"
grep -qiE "Fatal|Unexpected in " "$A_LOG" "$B_LOG"                && bad "фатальная ошибка в логе"        || ok "без фатальных ошибок"

rm -rf "$A_WORK" "$B_WORK"
[ "$RC" -eq 0 ] && printf '\033[32mСТИКЕРЫ E2E: OK\033[0m\n' || printf '\033[31mСТИКЕРЫ E2E: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
