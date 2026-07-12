#!/usr/bin/env bash
# @упоминания: alice пишет bob текст с @bob@local. Отправка идёт через MirrorOutgoing
# → авто-детект @user@server → mention-entity в content.entities (внутри E2E).
# Проверяем round-trip: mention-entity есть и в журнале alice (отправитель), и в
# журнале bob (получатель, после расшифровки) → рендерится нативно + f_mentioned.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"; SHARD="$ROOT/../target/debug"
SB="${SCRATCH:-/tmp/parvane-mention}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
TXT="привет @bob@local смотри-$(date +%s)"
AH="$A/tdata/parvane-history-alice@local.jsonl"; BH="$B/tdata/parvane-history-bob@local.jsonl"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!; sleep 1
for s in identity messenger; do PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 & done
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 "$SHARD/gateway" >"$SB/gw.log" 2>&1 & GW=$!; sleep 2

QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' "$BIN" -workdir "$B" >"$SB/b.out" 2>&1 & BP=$!
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' \
  PARVANE_AUTOSEND="bob@local:$TXT" "$BIN" -workdir "$A" >"$SB/a.out" 2>&1 & AP=$!

BL="$B/log.txt"
for i in $(seq 1 40); do grep -qa "входящее msg .* (alice@local): $TXT" "$BL" 2>/dev/null && break; sleep 1; done
sleep 2
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "── журнал alice (mention?) ──"; grep -oa '"type":"mention"[^}]*}' "$AH" 2>/dev/null | head
echo "── журнал bob (mention?) ──"; grep -oa '"type":"mention"[^}]*}' "$BH" 2>/dev/null | head
echo "──────────"

grep -qa "входящее msg .* (alice@local): $TXT" "$BL" && ok "bob получил сообщение" || bad "bob не получил"
grep -qa '"type":"mention"' "$AH" && ok "отправитель: @bob@local распознан как mention-entity (в журнале)" || bad "нет mention-entity у alice"
grep -qa '"type":"mention"' "$BH" && ok "получатель: mention-entity дошёл через E2E (в журнале bob)" || bad "нет mention-entity у bob"
if grep -qa "@bob@local" "$SB/messenger.db" 2>/dev/null; then
  bad "текст с @bob@local найден в messenger.db — не зашифровано!"
else
  ok "текст упоминания отсутствует в messenger.db (E2E держится)"
fi

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null; pkill -9 -x Telegram 2>/dev/null
[ "$RC" -eq 0 ] && printf '\033[32m@УПОМИНАНИЯ: OK\033[0m\n' || printf '\033[31m@УПОМИНАНИЯ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
