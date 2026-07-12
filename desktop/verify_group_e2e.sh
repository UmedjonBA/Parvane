#!/usr/bin/env bash
# Фаза 3 — E2E ГРУПП (Megolm/sender keys) в форке через gateway.
# alice создаёт группу с bob, раздаёт SKDM (свой session_key) по 1-на-1 E2E,
# затем шлёт групповое сообщение (Megolm). Проверяем:
#   1) bob расшифровал и инъецировал групповое сообщение (decrypt работает);
#   2) плейнтекста НЕТ в messenger.db (контент реально зашифрован);
#   3) в БД лежит content kind=group_encrypted (не открытый text);
#   4) SKDM sealed (from_user пуст у kind=encrypted — раздача ключа скрыта);
#   5) без фатальных ошибок.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
SHARD="$ROOT/../target/debug"
SB="${SCRATCH:-/tmp/parvane-grpe2e}"; rm -rf "$SB"; mkdir -p "$SB"
STAMP="$(date +%s)"
A_WORK="$SB/alice"; B_WORK="$SB/bob"; mkdir -p "$A_WORK/td" "$B_WORK/td"
A_LOG="$A_WORK/td/log.txt"; B_LOG="$B_WORK/td/log.txt"
SECRET="секрет-группы-$STAMP"
GNAME="ТайнаяГруппа"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!
sleep 1
for s in identity messenger; do
  PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 &
done
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 \
  PARVANE_GATEWAY_BIND=127.0.0.1:9222 PARVANE_LOG_LEVEL=info "$SHARD/gateway" >"$SB/gateway.log" 2>&1 & GW=$!
sleep 2

# bob первым (успеет опубликовать prekeys + подхватить группу до отправки).
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
  PARVANE_AUTOLOGIN='bob@local:test' \
  "$BIN" -workdir "$B_WORK/td" >"$B_WORK/stdout.log" 2>&1 & B_PID=$!
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
  PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOGROUP="$GNAME:bob@local" \
  PARVANE_AUTOGROUPSEND="$GNAME:$SECRET" \
  "$BIN" -workdir "$A_WORK/td" >"$A_WORK/stdout.log" 2>&1 & A_PID=$!

# Ждём инъекцию группового сообщения у bob (или таймаут).
for i in $(seq 1 60); do
  grep -qa "групповое .* от alice@local: $SECRET" "$B_LOG" 2>/dev/null && break
  sleep 1
done
sleep 2
kill "$A_PID" "$B_PID" 2>/dev/null; wait "$A_PID" "$B_PID" 2>/dev/null

echo "── ALICE ──"; grep -iE "Parvane: (AUTOGROUP|группа|отправлено|E2E)" "$A_LOG" 2>/dev/null | head
echo "── BOB ──";   grep -iE "Parvane: (группа синт|групповое|НЕ расшифров)" "$B_LOG" 2>/dev/null | head
echo "──────────"

GID=$(grep -a "группа '$GNAME' создана" "$A_LOG" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
[ -n "$GID" ] && ok "alice создала группу ($GID)" || bad "alice не создала группу"
grep -qa "группа синтезирована $GID" "$B_LOG" 2>/dev/null && ok "bob подхватил группу" || bad "bob не подхватил группу"
grep -qa "отправлено msg .* \[E2E\]" "$A_LOG" 2>/dev/null && ok "alice шифровала групповое (send [E2E])" || bad "нет [E2E] у alice"
grep -qa "групповое .* от alice@local: $SECRET" "$B_LOG" 2>/dev/null \
  && ok "bob РАСШИФРОВАЛ и инъецировал групповое сообщение" \
  || bad "bob не расшифровал/не получил групповое"
grep -qa "групповое E2E НЕ расшифровано" "$B_LOG" 2>/dev/null \
  && bad "у bob были нерасшифрованные групповые (гонка SKDM?)" \
  || ok "у bob нет нерасшифрованных групповых"

# ГЛАВНОЕ: плейнтекст секрета НЕ в messenger.db
if grep -qa "$SECRET" "$SB/messenger.db" 2>/dev/null; then
  bad "ПЛЕЙНТЕКСТ '$SECRET' найден в messenger.db — НЕ зашифровано!"
else
  ok "плейнтекст ОТСУТСТВУЕТ в messenger.db (E2E групп держится)"
fi
# content kind в БД — group_encrypted (не открытый text)
KINDS=$(sqlite3 "$SB/messenger.db" "SELECT DISTINCT kind FROM messages;" 2>/dev/null | tr '\n' ' ')
echo "kinds в БД: $KINDS"
echo "$KINDS" | grep -qw group_encrypted && ok "в БД есть group_encrypted" || bad "нет group_encrypted в БД"
# SKDM sealed: раздача ключа — kind=encrypted с пустым from_user
SKDM_FROM=$(sqlite3 "$SB/messenger.db" "SELECT DISTINCT from_user FROM messages WHERE kind='encrypted';" 2>/dev/null)
if [ -z "$SKDM_FROM" ]; then
  ok "SKDM sealed: from_user пуст у encrypted (раздача ключа скрыта)"
else
  bad "from_user НЕ пуст у encrypted: '$SKDM_FROM'"
fi
grep -qiE "Fatal|Unexpected in " "$A_LOG" "$B_LOG" 2>/dev/null && bad "фатальная ошибка в логе" || ok "без фатальных"

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null
[ "$RC" -eq 0 ] && printf '\033[32mФАЗА 3 E2E ГРУПП: OK\033[0m\n' || printf '\033[31mФАЗА 3 E2E ГРУПП: ПРОВАЛЫ\033[0m\n'
exit "$RC"
