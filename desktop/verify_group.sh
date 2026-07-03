#!/usr/bin/env bash
# Parvane — e2e групп в форке: alice создаёт группу с bob, bob (участник)
# авто-подхватывает её (RefreshGroups → синтез чата), затем групповое сообщение
# alice доставляется bob и инъецируется в чат группы. Требует nats+identity+
# messenger. Медиа/звук тут ни при чём — только текст в группе.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }
nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти nats+identity+messenger"; exit 2; }

pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
sleep 2
ALICE=$(mktemp -d /tmp/pv-vgrp-alice.XXXXXX); BOB=$(mktemp -d /tmp/pv-vgrp-bob.XXXXXX)
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOGROUP='ГруппаТест:bob@local' \
  "$BIN" -workdir "$ALICE/td" >"$ALICE/out.log" 2>&1 &
AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN='bob@local:test' \
  "$BIN" -workdir "$BOB/td" >"$BOB/out.log" 2>&1 &
BP=$!
AL="$ALICE/td/log.txt"; BL="$BOB/td/log.txt"
for i in $(seq 1 20); do grep -qa 'группа .* создана' "$AL" 2>/dev/null && break; sleep 1; done
GID=$(grep -a 'группа .* создана' "$AL" 2>/dev/null | head -1 | grep -oE '[0-9a-f-]{36}' | head -1)
for i in $(seq 1 20); do grep -qa "группа синтезирована $GID" "$BL" 2>/dev/null && break; sleep 1; done
python3 /tmp/pv_sendtext.py alice@local "$GID" "привет группе" >/dev/null 2>&1
for i in $(seq 1 15); do grep -qa "групповое .* от alice@local: привет группе" "$BL" 2>/dev/null && break; sleep 1; done

[ -n "$GID" ] && ok "alice создала группу ($GID)" || bad "группа не создана"
grep -qa "группа синтезирована $GID" "$AL" && ok "alice синтезировала чат группы" || bad "alice не синтезировала"
grep -qa "группа синтезирована $GID" "$BL" && ok "bob авто-подхватил и синтезировал группу" || bad "bob не подхватил группу"
grep -qa "групповое .* от alice@local: привет группе" "$BL" && ok "групповое сообщение доставлено и инъецировано bob" || bad "групповое сообщение не дошло"

kill -9 "$AP" "$BP" 2>/dev/null
if [ "$RC" -eq 0 ]; then printf '\033[32mГРУППЫ e2e: ВСЁ ОК\033[0m\n'; else printf '\033[31mГРУППЫ e2e: ПРОВАЛЫ\033[0m\n'; fi
exit $RC
