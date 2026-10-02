#!/usr/bin/env bash
# Фаза 0/1 e2e ЧЕРЕЗ GATEWAY: два реальных форка (alice ↔ bob) ходят в шину
# ТОЛЬКО через gateway (PARVANE_GATEWAY_URL). Поднимает весь стек сам.
# Проверяет: авто-регистрация+логин+auth через gateway, отправка, приём
# (inbox push Фазы 1), двусторонний обмен.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
# каталог чистим целиком: профили клиентов прошлого прогона (сессия, Olm-сессии)
# против свежих серверных БД дают «НЕ расшифровано» — второй прогон подряд падал
SB="${SCRATCH:-/tmp/parvane-p0c}"; rm -rf "$SB"; mkdir -p "$SB"
STAMP="$(date +%s)"
A_WORK="$SB/alice"; B_WORK="$SB/bob"; mkdir -p "$A_WORK/td" "$B_WORK/td"
A_LOG="$A_WORK/td/log.txt"; B_LOG="$B_WORK/td/log.txt"
A_TEXT="gw-alice-$STAMP"; B_TEXT="gw-bob-$STAMP"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

# стек
stack_up "$SB"

# два форка ТОЛЬКО через gateway (PARVANE_NATS_URL НЕ задаём)
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
  PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="bob@local:$A_TEXT" \
  "$BIN" -workdir "$A_WORK/td" >"$A_WORK/stdout.log" 2>&1 & A_PID=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' \
  PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="alice@local:$B_TEXT" \
  "$BIN" -workdir "$B_WORK/td" >"$B_WORK/stdout.log" 2>&1 & B_PID=$!

for i in $(seq 1 45); do
  grep -q "(alice@local): $A_TEXT" "$B_LOG" 2>/dev/null \
    && grep -q "(bob@local): $B_TEXT" "$A_LOG" 2>/dev/null && break
  sleep 1
done
sleep 2
kill "$A_PID" "$B_PID" 2>/dev/null; wait "$A_PID" "$B_PID" 2>/dev/null

echo "── ALICE (Parvane) ──"; grep -iE "Parvane: (login|сессия|отправлено|autosend|получено)" "$A_LOG" 2>/dev/null | head
echo "── BOB (Parvane) ──";   grep -iE "Parvane: (login|сессия|отправлено|autosend|получено)" "$B_LOG" 2>/dev/null | head
echo "── gateway ──"; grep -iE "авторизован" "$SB/gateway.log" 2>/dev/null | head

grep -q "autosend → bob@local: $A_TEXT"   "$A_LOG" && ok "alice отправила"      || bad "alice не отправила"
grep -q "autosend → alice@local: $B_TEXT" "$B_LOG" && ok "bob отправил"         || bad "bob не отправил"
grep -q "(alice@local): $A_TEXT" "$B_LOG" && ok "bob получил (через gateway)"  || bad "bob не получил"
grep -q "(bob@local): $B_TEXT"   "$A_LOG" && ok "alice получила (через gateway)"|| bad "alice не получила"
grep -qiE "Fatal|Unexpected in " "$A_LOG" "$B_LOG" && bad "фатальная ошибка" || ok "без фатальных"

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mФАЗА 0/1 КЛИЕНТ (gateway): OK\033[0m\n' || printf '\033[31mФАЗА 0/1 КЛИЕНТ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
