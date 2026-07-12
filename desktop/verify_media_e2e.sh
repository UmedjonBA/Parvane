#!/usr/bin/env bash
# Фаза 3: E2E МЕДИА. alice шлёт PNG bob через gateway. Проверяет:
#  - alice зашифровала (media отправлено [E2E]);
#  - bob РАСШИФРОВАЛ блоб и ДЕКОДИРОВАЛ PNG (получено фото 320x240) — если бы блоб
#    не расшифровался, PNG бы не распознался;
#  - cloud хранит ШИФРТЕКСТ (PNG-сигнатуры \x89PNG нет в cloud.db).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"; SHARD="$ROOT/../target/debug"
SB="${SCRATCH:-/tmp/parvane-media-e2e}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"; PNG="$SB/pic.png"
RC=0; ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

python3 - "$PNG" <<'PY'
import sys, struct, zlib
w,h=320,240; raw=b''
for y in range(h):
    row=b'\x00'
    for x in range(w): row+=bytes(((x*3)%256,(y*5)%256,((x+y)*2)%256,255))
    raw+=row
def ch(t,d):
    c=t+d; return struct.pack('>I',len(d))+c+struct.pack('>I',zlib.crc32(c)&0xffffffff)
open(sys.argv[1],'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+ch(b'IDAT',zlib.compress(raw,9))+ch(b'IEND',b''))
PY
echo "PNG: $(stat -c%s "$PNG") байт"

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!; sleep 1
for s in identity messenger cloud; do PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 & done
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 "$SHARD/gateway" >"$SB/gw.log" 2>&1 & GW=$!; sleep 2

# bob стартует, даём слить старую историю
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' "$BIN" -workdir "$B" >"$SB/b.out" 2>&1 & BP=$!
sleep 6
BEFORE=$(grep -c "получено фото" "$B/log.txt" 2>/dev/null || true)
# alice шлёт PNG
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOSENDFILE="bob@local:$PNG" "$BIN" -workdir "$A" >"$SB/a.out" 2>&1 & AP=$!
for i in $(seq 1 40); do
  AFTER=$(grep -c "получено фото" "$B/log.txt" 2>/dev/null || true)
  [ "$AFTER" -gt "$BEFORE" ] && grep -q "медиа отправлено" "$A/log.txt" 2>/dev/null && break
  sleep 1
done
sleep 2
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "── ALICE ──"; grep -iE "медиа отправлено|E2E" "$A/log.txt" 2>/dev/null | tail -3
echo "── BOB ──"; grep -iE "получено фото|расшифров|блоб" "$B/log.txt" 2>/dev/null | tail -3
AFTER=$(grep -c "получено фото" "$B/log.txt" 2>/dev/null || true)

grep -q "медиа отправлено msg .*\[E2E\]" "$A/log.txt" && ok "alice зашифровала медиа [E2E]" || bad "нет [E2E] у alice"
[ "$AFTER" -gt "$BEFORE" ] && ok "bob расшифровал+декодировал фото (получено фото)" || bad "bob не показал фото"
grep "получено фото.*alice@local" "$B/log.txt" 2>/dev/null | tail -1 | grep -q "320x240" && ok "PNG декодирован (320x240) → блоб расшифрован верно" || bad "PNG не декодирован"
if grep -aq $'\x89PNG' "$SB/cloud.db" 2>/dev/null; then bad "PNG-сигнатура НАЙДЕНА в cloud.db — блоб НЕ зашифрован!"; else ok "cloud.db без PNG-сигнатуры (блоб — шифртекст)"; fi
grep -qiE "Fatal|Unexpected in |блоб НЕ расшифрован" "$A/log.txt" "$B/log.txt" && bad "ошибка в логе" || ok "без фатальных"

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null; pkill -x cloud 2>/dev/null
[ "$RC" -eq 0 ] && printf '\033[32mE2E МЕДИА: OK\033[0m\n' || printf '\033[31mE2E МЕДИА: ПРОВАЛЫ\033[0m\n'
exit "$RC"
