#!/usr/bin/env bash
# Parvane Фаза 3d — sync при старте (офлайн-бэклог) + список диалогов + периодика.
# Ключевое отличие от 3c: сообщение публикуется bob→alice, ПОКА alice ОФЛАЙН
# (форк ещё не запущен). delivered-бродкаст уходит в никуда (NATS fire-and-forget).
# Значит доставить его может ТОЛЬКО стартовый pump в AfterSessionReady. Проверяем:
#   1) после старта alice входящее всё равно получено (startup sync);
#   2) диалог с отправителем виден в списке чатов (inChatList=1);
#   3) периодический sync-таймер запущен;
#   4) без фатальных ошибок.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
WORKDIR="$(mktemp -d /tmp/parvane-3d.XXXXXX)"
TDLOG="$WORKDIR/td/log.txt"
SELF="alice@local"
SENDER="bob@local"
TEXT="phase3d-$(date +%s)"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }

# 1. JWT bob
BOBJWT="$(nats --server "$URL" req identity.token.issue \
    '{"user":"bob@local","password":"test"}' 2>/dev/null \
    | grep -m1 '^{' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)"
[ -n "$BOBJWT" ] || { echo "не удалось получить JWT bob (identity запущен?)"; exit 2; }

# 2. ОФЛАЙН-публикация bob→alice (alice ещё не запущена)
ENVELOPE="$(python3 - "$BOBJWT" "$SENDER" "$SELF" "$TEXT" <<'PY'
import sys, json, time, secrets
jwt, frm, to, text = sys.argv[1:5]
ms = int(time.time() * 1000)
b = bytearray(secrets.token_bytes(16))
b[0:6] = ms.to_bytes(6, 'big'); b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80
h = b.hex()
uid = f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
print(json.dumps({"id": uid, "from": frm, "ts": int(time.time()), "token": jwt,
                  "payload": {"to": to, "content": {"kind": "text", "text": text}}}))
PY
)"
echo "офлайн-publish bob→alice (до старта alice): $TEXT"
nats --server "$URL" pub msg.chat.send "$ENVELOPE" >/dev/null 2>&1
sleep 1  # дать шарду сохранить; delivered уйдёт в никуда

# 3. ТЕПЕРЬ запускаем alice — backlog должен подтянуться стартовым pump-ом
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN="$SELF:test" \
  "$BIN" -workdir "$WORKDIR/td" >"$WORKDIR/stdout.log" 2>&1 &
FORKPID=$!
for i in $(seq 1 25); do
    grep -q "Parvane: получено .* от $SENDER: $TEXT" "$TDLOG" 2>/dev/null && break
    sleep 1
done
# дать таймеру шанс отработать минимум один интервал
sleep 4
kill "$FORKPID" 2>/dev/null; wait "$FORKPID" 2>/dev/null

echo "── приём/диалог/таймер (из log.txt) ──"
grep -iE "Parvane: (получено|диалог|инъецировано|периодический|sync ошибка)" "$TDLOG" 2>/dev/null || echo "(нет строк!)"
echo "── syncs alice в messenger-логе (свидетельство периодики) ──"
SYNCS="$(grep -c "Sync для $SELF" /tmp/parvane-msg.log 2>/dev/null || echo 0)"
echo "Sync для $SELF в логе шарда: $SYNCS (накопительно)"
echo "────────────────────────────"

grep -q "Parvane: получено .* от $SENDER: $TEXT" "$TDLOG" && ok "офлайн-бэклог получен стартовым sync" || bad "офлайн-сообщение не получено при старте"
grep -q "Parvane: диалог $SENDER — в списке=1" "$TDLOG" && ok "диалог виден в списке чатов"           || bad "диалог не в списке"
grep -q "Parvane: периодический sync" "$TDLOG" && ok "периодический sync-таймер запущен"               || bad "периодика не запущена"
grep -qiE "Fatal|Unexpected in " "$TDLOG" && bad "в логе фатальная ошибка" || ok "без фатальных ошибок"

rm -rf "$WORKDIR"
[ "$RC" -eq 0 ] && printf '\033[32mФАЗА 3d: OK\033[0m\n' || printf '\033[31mФАЗА 3d: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
