#!/usr/bin/env bash
# Parvane — e2e звонка между двумя РЕАЛЬНЫМИ экземплярами форка (Э4-b, без звука).
# alice звонит bob (PARVANE_AUTOCALL), bob авто-принимает (PARVANE_AUTOACCEPT).
# Медиа — StubMediaBackend, поэтому проверяем ВЕСЬ путь сигналинга по логам:
#   оба поднимают сессию + регистрируют ключ звонков;
#   bob получает входящий от alice; ОБА доходят до состояния Active.
# Требует запущенные nats + identity + call (см. scripts/run_all_tests.sh окружение).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти nats+identity+call"; exit 2; }

pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
sleep 2
BOB=$(mktemp -d /tmp/pv-vcall-bob.XXXXXX)
ALICE=$(mktemp -d /tmp/pv-vcall-alice.XXXXXX)

QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN='bob@local:test' PARVANE_AUTOACCEPT='1' \
  "$BIN" -workdir "$BOB/td" >"$BOB/out.log" 2>&1 &
BOBPID=$!
sleep 6
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOCALL='bob@local' \
  "$BIN" -workdir "$ALICE/td" >"$ALICE/out.log" 2>&1 &
ALICEPID=$!

AL="$ALICE/td/log.txt"; BL="$BOB/td/log.txt"
# Ждём, пока оба выйдут в Active (или таймаут).
for i in $(seq 1 25); do
    grep -qa 'звонок → Active' "$AL" 2>/dev/null \
      && grep -qa 'звонок → Active' "$BL" 2>/dev/null && break
    sleep 1
done

grep -qa 'зарегистрирован ключ звонков' "$AL" && ok "alice зарегистрировала ключ" || bad "alice не зарегистрировала ключ"
grep -qa 'зарегистрирован ключ звонков' "$BL" && ok "bob зарегистрировал ключ" || bad "bob не зарегистрировал ключ"
grep -qa 'исходящий звонок → bob@local' "$AL" && ok "alice инициировала звонок" || bad "alice не позвонила"
grep -qa 'ВХОДЯЩИЙ звонок от alice@local' "$BL" && ok "bob получил входящий от alice" || bad "bob не получил входящий"
grep -qa 'звонок → Active' "$AL" && ok "alice → Active" || bad "alice не дошла до Active"
grep -qa 'звонок → Active' "$BL" && ok "bob → Active" || bad "bob не дошёл до Active"

kill -9 "$BOBPID" "$ALICEPID" 2>/dev/null
if [ "$RC" -eq 0 ]; then printf '\033[32mЗВОНОК e2e: ВСЁ ОК\033[0m\n'; else printf '\033[31mЗВОНОК e2e: ЕСТЬ ПРОВАЛЫ\033[0m\n'; fi
exit $RC
