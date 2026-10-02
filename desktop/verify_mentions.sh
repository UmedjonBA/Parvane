#!/usr/bin/env bash
# @упоминания: alice пишет bob текст с @bob@local. Отправка идёт через MirrorOutgoing
# → авто-детект @user@server → mention-entity в content.entities (внутри E2E).
# Проверяем round-trip по логу: mention-entity распознан у alice (отправитель) и
# найден у bob после расшифровки (f_mentioned); журналы на диске зашифрованы.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
SB="${SCRATCH:-/tmp/parvane-mention}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
TXT="привет @bob@local смотри-$(date +%s)"
AH="$A/tdata/parvane-history-alice@local.jsonl"; BH="$B/tdata/parvane-history-bob@local.jsonl"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

stack_up "$SB"

QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b.out" 2>&1 & BP=$!
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" \
  PARVANE_AUTOSEND="bob@local:$TXT" "$BIN" -workdir "$A" >"$SB/a.out" 2>&1 & AP=$!

BL="$B/log.txt"
for i in $(seq 1 40); do grep -qa "входящее msg .* (alice@local): $TXT" "$BL" 2>/dev/null && break; sleep 1; done
sleep 2
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

AL="$A/log.txt"
echo "── mention в логах ──"; grep -a "mention-entity" "$AL" "$BL" 2>/dev/null | head
echo "──────────"

grep -qa "входящее msg .* (alice@local): $TXT" "$BL" && ok "bob получил сообщение" || bad "bob не получил"
# Журналы на диске зашифрованы (P-13) — entity в них больше не прочитать; round-trip
# сверяем по логу: отправитель распознал @bob@local, получатель после расшифровки
# нашёл mention-entity СВОЕГО адреса (→ нативный флаг f_mentioned).
grep -qaE "исходящее msg .*: mention-entity ×1" "$AL" && ok "отправитель: @bob@local распознан как mention-entity" || bad "нет mention-entity у alice"
grep -qaE "msg .*: mention-entity этого аккаунта → f_mentioned" "$BL" && ok "получатель: mention-entity дошёл через E2E (f_mentioned)" || bad "нет mention-entity у bob"
for J in "$AH" "$BH"; do
  if [ -s "$J" ]; then
    head -c 5 "$J" | grep -q '^PVSE1' && ! grep -qa "@bob@local" "$J" \
      && ok "журнал $(basename "$J") зашифрован (PVSE1)" || bad "журнал $(basename "$J") лежит открытым текстом"
  else
    bad "нет журнала $J"
  fi
done
if grep -qa "@bob@local" "$SB/messenger.db" 2>/dev/null; then
  bad "текст с @bob@local найден в messenger.db — не зашифровано!"
else
  ok "текст упоминания отсутствует в messenger.db (E2E держится)"
fi

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32m@УПОМИНАНИЯ: OK\033[0m\n' || printf '\033[31m@УПОМИНАНИЯ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
