#!/usr/bin/env bash
# Parvane Фаза 3b — e2e-проверка врезки отправки.
# Поднимает подписчика на msg.chat.send, запускает форк headless с
# PARVANE_AUTOLOGIN (логин через identity) + PARVANE_AUTOSEND (синтетическая
# отправка после готовности сессии), затем проверяет:
#   1) лог форка содержит "autosend" и "Parvane: отправлено" (путь публикации);
#   2) подписчик поймал событие msg.chat.send с нужным текстом и адресатом.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
WORKDIR="$(mktemp -d /tmp/parvane-3b.XXXXXX)"
SUBLOG="$WORKDIR/sub.log"
FORKLOG="$WORKDIR/fork.log"
SELF="alice@local"
PEER="bob@local"
TEXT="phase3b-$(date +%s)"
RC=0

ok()   { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }

# 1. подписчик на msg.chat.send
nats --server "$URL" sub msg.chat.send >"$SUBLOG" 2>&1 &
SUBPID=$!
sleep 1

# 2. запуск форка headless: логин + автосенд.
# ВАЖНО: tdesktop пишет LOG() в <workdir>/log.txt, а НЕ в stdout — проверяем его.
TDLOG="$WORKDIR/td/log.txt"
QT_QPA_PLATFORM=offscreen \
PARVANE_NATS_URL="$URL" \
PARVANE_AUTOLOGIN="$SELF:test" \
PARVANE_AUTOSEND="$PEER:$TEXT" \
  "$BIN" -workdir "$WORKDIR/td" >"$FORKLOG" 2>&1 &
FORKPID=$!

# ждём до 25с появления autosend-лога, потом гасим форк
for i in $(seq 1 25); do
    grep -q "Parvane: autosend" "$TDLOG" 2>/dev/null && break
    sleep 1
done
sleep 2
kill "$FORKPID" 2>/dev/null; wait "$FORKPID" 2>/dev/null
kill "$SUBPID" 2>/dev/null; wait "$SUBPID" 2>/dev/null

echo "── лог форка (Parvane, из log.txt) ──"
grep -i parvane "$TDLOG" 2>/dev/null || echo "(нет строк Parvane!)"
echo "── подписчик msg.chat.send ──"
cat "$SUBLOG"
echo "────────────────────────────"

grep -q "Parvane: login OK"  "$TDLOG" && ok "логин прошёл"            || bad "логин не прошёл"
grep -q "Parvane: сессия поднята" "$TDLOG" && ok "сессия поднята"     || bad "сессия не поднялась"
grep -q "Parvane: autosend"  "$TDLOG" && ok "autosend-хук сработал"   || bad "autosend-хук не сработал"
grep -q "Parvane: отправлено" "$TDLOG" && ok "публикация выполнена"   || bad "публикации в логе нет"
grep -q "$TEXT" "$SUBLOG" && ok "msg.chat.send пойман подписчиком ($TEXT)" || bad "событие msg.chat.send не поймано"
grep -q "\"to\":\"$PEER\"" "$SUBLOG" && ok "адресат в payload = $PEER"  || bad "адресат в payload неверен"

rm -rf "$WORKDIR"
[ "$RC" -eq 0 ] && printf '\033[32mФАЗА 3b: OK\033[0m\n' || printf '\033[31mФАЗА 3b: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
