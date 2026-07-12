#!/usr/bin/env bash
# Parvane — два РЕАЛЬНЫХ экземпляра форка одновременно (alice ↔ bob).
# Никакого внешнего `nats pub` — оба сообщения отправляют сами форки через
# обычный путь ApiWrap::sendMessage → MirrorOutgoing → msg.chat.send.
# Проверяем полный двусторонний обмен:
#   1) alice отправила (autosend → bob);
#   2) bob отправил  (autosend → alice);
#   3) bob получил сообщение alice;
#   4) alice получила сообщение bob;
#   5) у обоих диалог с собеседником в списке=1;
#   6) ни в одном логе нет фатальных ошибок.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
A_USER="${A_USER:-alice@local}"
B_USER="${B_USER:-bob@local}"
STAMP="$(date +%s)"
A_WORK="$(mktemp -d /tmp/parvane-2i-alice.XXXXXX)"
B_WORK="$(mktemp -d /tmp/parvane-2i-bob.XXXXXX)"
A_LOG="$A_WORK/td/log.txt"
B_LOG="$B_WORK/td/log.txt"
A_TEXT="from-alice-$STAMP"
B_TEXT="from-bob-$STAMP"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
nats --server "$URL" req identity.token.issue "{\"user\":\"$A_USER\",\"password\":\"test\"}" \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти шарды"; exit 2; }

echo "alice workdir: $A_WORK"
echo "bob   workdir: $B_WORK"

# E2E: свежий workdir = НОВОЕ Olm-устройство. Отправитель запечатывает для
# бандла, который есть у identity В МОМЕНТ отправки — поэтому получатель обязан
# опубликовать prekeys ДО отправки в его сторону. Последовательность:
# bob (без autosend, публикует устройство) → alice шлёт bob'у → bob
# перезапускается в ТОМ ЖЕ workdir (устройство персистно) и шлёт alice.
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$B_USER:test" \
  "$BIN" -workdir "$B_WORK/td" >"$B_WORK/stdout.log" 2>&1 &
B_PID=$!
for i in $(seq 1 30); do
    grep -q "Parvane: E2E-устройство готово" "$B_LOG" 2>/dev/null && break
    sleep 1
done
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$A_USER:test" PARVANE_AUTOSEND="$B_USER:$A_TEXT" \
  "$BIN" -workdir "$A_WORK/td" >"$A_WORK/stdout.log" 2>&1 &
A_PID=$!
for i in $(seq 1 40); do
    grep -q "Parvane: входящее msg .* ($A_USER): $A_TEXT" "$B_LOG" 2>/dev/null && break
    sleep 1
done
kill "$B_PID" 2>/dev/null; wait "$B_PID" 2>/dev/null
mv "$B_LOG" "$B_WORK/td/log.first.txt"
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$B_USER:test" PARVANE_AUTOSEND="$A_USER:$B_TEXT" \
  "$BIN" -workdir "$B_WORK/td" >"$B_WORK/stdout2.log" 2>&1 &
B_PID=$!
for i in $(seq 1 40); do
    grep -q "Parvane: входящее msg .* ($B_USER): $B_TEXT" "$A_LOG" 2>/dev/null && break
    sleep 1
done
sleep 2
kill "$A_PID" "$B_PID" 2>/dev/null; wait "$A_PID" "$B_PID" 2>/dev/null
# Обе фазы bob'а — в один файл для дальнейших greps.
cat "$B_WORK/td/log.first.txt" >> "$B_LOG" 2>/dev/null || true

echo "── ALICE log.txt (Parvane) ──"
grep -iE "Parvane: (login|сессия|отправлено|autosend|входящее|диалог)" "$A_LOG" 2>/dev/null || echo "(пусто)"
echo "── BOB log.txt (Parvane) ──"
grep -iE "Parvane: (login|сессия|отправлено|autosend|входящее|диалог)" "$B_LOG" 2>/dev/null || echo "(пусто)"
echo "─────────────────────────────"

grep -q "Parvane: autosend → $B_USER: $A_TEXT"   "$A_LOG" && ok "alice отправила bob"        || bad "alice не отправила"
grep -q "Parvane: autosend → $A_USER: $B_TEXT" "$B_LOG" && ok "bob отправил alice"          || bad "bob не отправил"
grep -q "Parvane: входящее msg .* ($A_USER): $A_TEXT" "$B_LOG" && ok "bob получил от alice"     || bad "bob не получил alice"
grep -q "Parvane: входящее msg .* ($B_USER): $B_TEXT"   "$A_LOG" && ok "alice получила от bob"    || bad "alice не получила bob"
grep -q "Parvane: диалог $B_USER — в списке=1"   "$A_LOG" && ok "у alice диалог bob в списке"  || bad "у alice нет диалога"
grep -q "Parvane: диалог $A_USER — в списке=1" "$B_LOG" && ok "у bob диалог alice в списке"  || bad "у bob нет диалога"
grep -qiE "Fatal|Unexpected in " "$A_LOG" "$B_LOG" && bad "фатальная ошибка в логе" || ok "без фатальных ошибок"

rm -rf "$A_WORK" "$B_WORK"
[ "$RC" -eq 0 ] && printf '\033[32mДВА ЭКЗЕМПЛЯРА: OK\033[0m\n' || printf '\033[31mДВА ЭКЗЕМПЛЯРА: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
