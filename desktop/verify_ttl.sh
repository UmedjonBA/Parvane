#!/usr/bin/env bash
# Самоуничтожение (TTL) 1-на-1: alice ставит таймер чата (3с) и шлёт секрет bob.
# Проверяем:
#   1) alice отправила [E2E];
#   2) bob получил и поставил нативный ttl_period (лог «самоуничтожится через 3с»);
#   3) alice авто-удалила СВОЁ эхо через ~3с (лог «своё … самоуничтожено»);
#   4) TTL-сообщение ЭФЕМЕРНО: нет в журналах истории (ни alice, ни bob);
#   5) плейнтекст секрета отсутствует в messenger.db (ttl едет ВНУТРИ E2E-content).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
SB="${SCRATCH:-/tmp/parvane-ttl}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
SECRET="секрет-ttl-$(date +%s)"
AH="$A/tdata/parvane-history-alice@local.jsonl"; BH="$B/tdata/parvane-history-bob@local.jsonl"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

stack_up "$SB"

QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b.out" 2>&1 & BP=$!
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" \
  PARVANE_AUTOTTL='bob@local:3' PARVANE_AUTOSEND="bob@local:$SECRET" \
  "$BIN" -workdir "$A" >"$SB/a.out" 2>&1 & AP=$!

AL="$A/log.txt"; BL="$B/log.txt"
for i in $(seq 1 40); do grep -qa "ttl-сообщение .* через 3с" "$BL" 2>/dev/null && break; sleep 1; done
# Ждём срабатывания авто-удаления своего эха у alice (>3с после отправки).
for i in $(seq 1 12); do grep -qa "ttl — своё .* самоуничтожено" "$AL" 2>/dev/null && break; sleep 1; done
sleep 2
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "── ALICE ──"; grep -aE "Parvane: (AUTOTTL|отправлено|ttl —)" "$AL" 2>/dev/null | head
echo "── BOB ──"; grep -aE "Parvane: (ttl-сообщение|входящее)" "$BL" 2>/dev/null | head
echo "──────────"

grep -qa "отправлено msg .* \[E2E\]" "$AL" && ok "alice отправила [E2E]" || bad "alice не отправила E2E"
grep -qa "ttl-сообщение .* через 3с" "$BL" && ok "bob поставил нативный ttl_period (авто-удаление)" || bad "bob НЕ получил ttl_period"
grep -qa "ttl — своё .* самоуничтожено" "$AL" && ok "alice авто-удалила своё эхо через ~3с" || bad "alice НЕ авто-удалила своё эхо"
if grep -qa "$SECRET" "$AH" 2>/dev/null || grep -qa "$SECRET" "$BH" 2>/dev/null; then
  bad "TTL-сообщение попало в журнал истории (должно быть эфемерным)"
else
  ok "TTL-сообщение эфемерно (нет в журналах истории)"
fi
if grep -qa "$SECRET" "$SB/messenger.db" 2>/dev/null; then
  bad "плейнтекст секрета в messenger.db — не зашифровано!"
else
  ok "плейнтекст секрета отсутствует в messenger.db (E2E держится)"
fi

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mTTL САМОУНИЧТОЖЕНИЕ: OK\033[0m\n' || printf '\033[31mTTL: ПРОВАЛЫ\033[0m\n'
exit "$RC"
