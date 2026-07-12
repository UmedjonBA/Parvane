#!/usr/bin/env bash
# Parvane — e2e опросов двумя реальными экземплярами (alice ↔ bob).
#   1) alice создаёт опрос (PARVANE_AUTOPOLL) → E2E poll-контент в шину;
#   2) bob получает опрос (инъекция MTP_messageMediaPoll) и голосует
#      (PARVANE_AUTOVOTE) → E2E poll_vote;
#   3) alice получает голос — агрегат применён (applyPollState);
#   4) рестарт alice: опрос и голос восстановлены из журнала;
#   5) без фатальных ошибок.
# Пользователи переопределяются: A_USER=palice@local B_USER=pbob@local ./verify_polls.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
A_USER="${A_USER:-alice@local}"
B_USER="${B_USER:-bob@local}"
STAMP="$(date +%s)"
A_WORK="$(mktemp -d /tmp/parvane-poll-alice.XXXXXX)"
B_WORK="$(mktemp -d /tmp/parvane-poll-bob.XXXXXX)"
A_LOG="$A_WORK/td/log.txt"
B_LOG="$B_WORK/td/log.txt"
QUESTION="poll-$STAMP"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
nats --server "$URL" req identity.token.issue "{\"user\":\"$A_USER\",\"password\":\"test\"}" \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти шарды"; exit 2; }

echo "alice workdir: $A_WORK"
echo "bob   workdir: $B_WORK"

# Сначала bob (его prekeys должны быть опубликованы до sealFor у alice).
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$B_USER:test" PARVANE_AUTOVOTE='1' \
  "$BIN" -workdir "$B_WORK/td" >"$B_WORK/stdout.log" 2>&1 &
B_PID=$!
sleep 4
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$A_USER:test" \
  PARVANE_AUTOPOLL="$B_USER:$QUESTION:вариант А,вариант Б,вариант В" \
  "$BIN" -workdir "$A_WORK/td" >"$A_WORK/stdout.log" 2>&1 &
A_PID=$!

# Ждём: bob проголосовал и alice получила голос.
for i in $(seq 1 45); do
    grep -q "Parvane: опрос .* — poll_vote от $B_USER" "$A_LOG" 2>/dev/null && break
    sleep 1
done
sleep 2
kill "$A_PID" "$B_PID" 2>/dev/null; wait "$A_PID" "$B_PID" 2>/dev/null

echo "── ALICE log.txt (poll) ──"
grep -iE "Parvane: (autopoll|опрос|inner-контент)" "$A_LOG" 2>/dev/null || echo "(пусто)"
echo "── BOB log.txt (poll) ──"
grep -iE "Parvane: (autovote|опрос|inner-контент)" "$B_LOG" 2>/dev/null || echo "(пусто)"
echo "─────────────────────────"

grep -q "Parvane: autopoll → $B_USER: $QUESTION" "$A_LOG" && ok "alice: autopoll сработал"          || bad "alice: autopoll не сработал"
grep -q "Parvane: опрос создан → $B_USER" "$A_LOG"        && ok "alice: опрос создан (эхо+шина)"    || bad "alice: опрос не создан"
grep -q "Parvane: опрос .* от $A_USER инъецирован" "$B_LOG" && ok "bob: опрос получен и инъецирован" || bad "bob: опрос не получен"
grep -q "Parvane: autovote — опрос" "$B_LOG"              && ok "bob: автоголос отправлен"           || bad "bob: автоголос не сработал"
grep -q "Parvane: опрос .* — poll_vote от $B_USER" "$A_LOG" && ok "alice: голос bob применён"        || bad "alice: голос bob не пришёл"
grep -qiE "Fatal|Unexpected in " "$A_LOG" "$B_LOG"        && bad "фатальная ошибка в логе"           || ok "без фатальных ошибок"

# ── Фаза 2: рестарт alice — опрос и голос переживают рестарт (журнал) ────────
mv "$A_LOG" "$A_WORK/td/log.first.txt"
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$A_USER:test" \
  "$BIN" -workdir "$A_WORK/td" >"$A_WORK/stdout2.log" 2>&1 &
A_PID=$!
for i in $(seq 1 30); do
    grep -q "Parvane: опрос .* инъецирован" "$A_LOG" 2>/dev/null && break
    sleep 1
done
sleep 2
kill "$A_PID" 2>/dev/null; wait "$A_PID" 2>/dev/null

grep -q "Parvane: опрос .* инъецирован" "$A_LOG"            && ok "alice: опрос восстановлен после рестарта" || bad "alice: опрос НЕ восстановлен"
grep -q "Parvane: опрос .* — poll_vote от $B_USER" "$A_LOG" && ok "alice: голос восстановлен после рестарта" || bad "alice: голос НЕ восстановлен"

rm -rf "$A_WORK" "$B_WORK"
[ "$RC" -eq 0 ] && printf '\033[32mОПРОСЫ E2E: OK\033[0m\n' || printf '\033[31mОПРОСЫ E2E: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
