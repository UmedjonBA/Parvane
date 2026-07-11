#!/usr/bin/env bash
# Фаза 2 e2e: два форка через gateway (autologin+register), 1-на-1 текст.
# Проверяет: доставку в обе стороны И что контент ЗАШИФРОВАН (в messenger.db
# нет плейнтекста; отправка помечена [E2E]).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
SHARD="$ROOT/../target/debug"
SB="${SCRATCH:-/tmp/parvane-p2c}"; rm -rf "$SB"; mkdir -p "$SB" # полная очистка (tdata тоже)
STAMP="$(date +%s)"
A_WORK="$SB/alice"; B_WORK="$SB/bob"; mkdir -p "$A_WORK/td" "$B_WORK/td"
A_LOG="$A_WORK/td/log.txt"; B_LOG="$B_WORK/td/log.txt"
A_TEXT="e2e-alice-$STAMP"; B_TEXT="e2e-bob-$STAMP"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!
sleep 1
for s in identity messenger; do
  PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 &
done
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 \
  PARVANE_GATEWAY_BIND=127.0.0.1:9222 PARVANE_LOG_LEVEL=info "$SHARD/gateway" >"$SB/gateway.log" 2>&1 & GW=$!
sleep 2

QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
  PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOSEND="bob@local:$A_TEXT" \
  "$BIN" -workdir "$A_WORK/td" >"$A_WORK/stdout.log" 2>&1 & A_PID=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
  PARVANE_AUTOLOGIN='bob@local:test' PARVANE_AUTOSEND="alice@local:$B_TEXT" \
  "$BIN" -workdir "$B_WORK/td" >"$B_WORK/stdout.log" 2>&1 & B_PID=$!

for i in $(seq 1 50); do
  grep -q "(alice@local): $A_TEXT" "$B_LOG" 2>/dev/null \
    && grep -q "(bob@local): $B_TEXT" "$A_LOG" 2>/dev/null && break
  sleep 1
done
sleep 2
kill "$A_PID" "$B_PID" 2>/dev/null; wait "$A_PID" "$B_PID" 2>/dev/null

echo "── ALICE ──"; grep -iE "Parvane: (login|сессия|E2E|отправлено|получено|входящее|расшифров)" "$A_LOG" 2>/dev/null | head
echo "── BOB ──";   grep -iE "Parvane: (login|сессия|E2E|отправлено|получено|входящее|расшифров)" "$B_LOG" 2>/dev/null | head

# доставка в обе стороны
grep -q "(alice@local): $A_TEXT" "$B_LOG" && ok "bob получил текст alice" || bad "bob не получил"
grep -q "(bob@local): $B_TEXT"   "$A_LOG" && ok "alice получила текст bob" || bad "alice не получила"
# отправка помечена E2E
grep -q "отправлено msg .* → bob@local \[E2E\]" "$A_LOG" && ok "alice шифровала (send [E2E])" || bad "нет [E2E] у alice"
# ГЛАВНОЕ: плейнтекста НЕТ в БД messenger (лежит шифртекст)
if grep -qa "$A_TEXT" "$SB/messenger.db" 2>/dev/null; then
  bad "ПЛЕЙНТЕКСТ '$A_TEXT' найден в messenger.db — НЕ зашифровано!"
else
  ok "плейнтекст alice ОТСУТСТВУЕТ в messenger.db (E2E держится)"
fi
if grep -qa "$B_TEXT" "$SB/messenger.db" 2>/dev/null; then
  bad "ПЛЕЙНТЕКСТ '$B_TEXT' найден в messenger.db"
else
  ok "плейнтекст bob ОТСУТСТВУЕТ в messenger.db"
fi
grep -qiE "Fatal|Unexpected in " "$A_LOG" "$B_LOG" && bad "фатальная ошибка" || ok "без фатальных"

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null
[ "$RC" -eq 0 ] && printf '\033[32mФАЗА 2 E2E: OK\033[0m\n' || printf '\033[31mФАЗА 2 E2E: ПРОВАЛЫ\033[0m\n'
exit "$RC"
