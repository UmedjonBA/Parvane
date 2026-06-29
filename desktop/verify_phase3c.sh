#!/usr/bin/env bash
# Parvane Фаза 3c — e2e-проверка приёма входящих.
# Запускает форк как alice (autologin), затем ВНЕШНЕ публикует msg.chat.send
# от bob→alice (полный конверт ParvaneEvent, UUID v7, JWT bob). Ожидаем, что
# onDelivered у alice триггерит pump → sync → инъекция в Data::Session, и в
# <workdir>/log.txt появляется "Parvane: получено ... от bob@local: <text>".
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
WORKDIR="$(mktemp -d /tmp/parvane-3c.XXXXXX)"
TDLOG="$WORKDIR/td/log.txt"
SELF="alice@local"
SENDER="bob@local"
TEXT="phase3c-$(date +%s)"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }

# 1. JWT отправителя (bob)
BOBJWT="$(nats --server "$URL" req identity.token.issue \
    '{"user":"bob@local","password":"test"}' 2>/dev/null \
    | grep -m1 '^{' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)"
[ -n "$BOBJWT" ] || { echo "не удалось получить JWT bob (identity запущен?)"; exit 2; }

# 2. форк как alice
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN="$SELF:test" \
  "$BIN" -workdir "$WORKDIR/td" >"$WORKDIR/stdout.log" 2>&1 &
FORKPID=$!
for i in $(seq 1 25); do
    grep -q "Parvane: сессия поднята" "$TDLOG" 2>/dev/null && break
    sleep 1
done

# 3. внешняя публикация bob→alice (полный конверт с UUID v7)
ENVELOPE="$(python3 - "$BOBJWT" "$SENDER" "$SELF" "$TEXT" <<'PY'
import sys, json, time, secrets
jwt, frm, to, text = sys.argv[1:5]
ms = int(time.time() * 1000)
b = bytearray(secrets.token_bytes(16))
b[0:6] = ms.to_bytes(6, 'big')         # 48-бит timestamp
b[6] = (b[6] & 0x0f) | 0x70            # версия 7
b[8] = (b[8] & 0x3f) | 0x80            # variant
h = b.hex()
uid = f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
print(json.dumps({
    "id": uid, "from": frm, "ts": int(time.time()), "token": jwt,
    "payload": {"to": to, "content": {"kind": "text", "text": text}},
}))
PY
)"
echo "publish bob→alice: $TEXT"
nats --server "$URL" pub msg.chat.send "$ENVELOPE" >/dev/null 2>&1

# 4. ждём приёма
for i in $(seq 1 25); do
    grep -q "Parvane: получено .* от $SENDER: $TEXT" "$TDLOG" 2>/dev/null && break
    sleep 1
done
sleep 1
kill "$FORKPID" 2>/dev/null; wait "$FORKPID" 2>/dev/null

echo "── приём (Parvane, из log.txt) ──"
grep -iE "Parvane: (сессия|получено|инъецировано|sync ошибка)" "$TDLOG" 2>/dev/null || echo "(нет строк приёма!)"
echo "── ошибки/варнинги вокруг инъекции ──"
grep -iE "Critical|Fatal|Unexpected|assert" "$TDLOG" 2>/dev/null | head -5 || true
echo "────────────────────────────"

grep -q "Parvane: сессия поднята" "$TDLOG" && ok "сессия поднята"                       || bad "сессия не поднялась"
grep -q "Parvane: получено .* от $SENDER: $TEXT" "$TDLOG" && ok "входящее получено и залогировано" || bad "входящее не получено"
grep -q "Parvane: инъецировано" "$TDLOG" && ok "сообщение инъецировано в Data::Session" || bad "инъекции не было"
# процесс не должен был упасть до приёма (лог продолжается после инъекции)
grep -qiE "Fatal|Unexpected in " "$TDLOG" && bad "в логе фатальная ошибка" || ok "без фатальных ошибок"

rm -rf "$WORKDIR"
[ "$RC" -eq 0 ] && printf '\033[32mФАЗА 3c: OK\033[0m\n' || printf '\033[31mФАЗА 3c: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
