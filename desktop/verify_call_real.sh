#!/usr/bin/env bash
# Parvane — e2e РЕАЛЬНОГО звонка (webrtc, Э3-b) между двумя экземплярами форка.
# PARVANE_REAL_MEDIA=1 → настоящий webrtc::PeerConnection (tg_owt) вместо заглушки.
# Проверяем, что webrtc-фабрика поднимается и между двумя экземплярами реально
# устанавливается ICE/DTLS-соединение (оба доходят до Active из webrtc-колбэка
# OnConnectionChange(kConnected)). САМ ЗВУК headless не проверить — только связь.
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
BOB=$(mktemp -d /tmp/pv-rcall-bob.XXXXXX); ALICE=$(mktemp -d /tmp/pv-rcall-alice.XXXXXX)

QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_REAL_MEDIA=1 \
  PARVANE_AUTOLOGIN='bob@local:test' PARVANE_AUTOACCEPT='1' \
  "$BIN" -workdir "$BOB/td" >"$BOB/out.log" 2>&1 &
BOBPID=$!
sleep 7
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_REAL_MEDIA=1 \
  PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOCALL='bob@local' \
  "$BIN" -workdir "$ALICE/td" >"$ALICE/out.log" 2>&1 &
ALICEPID=$!

AL="$ALICE/td/log.txt"; BL="$BOB/td/log.txt"
for i in $(seq 1 30); do
    grep -qa 'звонок → Active' "$AL" 2>/dev/null \
      && grep -qa 'звонок → Active' "$BL" 2>/dev/null && break
    sleep 1
done

grep -qa 'webrtc-фабрика создана, ok=1' "$AL" && ok "alice: webrtc-фабрика поднялась" || bad "alice: нет webrtc-фабрики"
grep -qa 'webrtc-фабрика создана, ok=1' "$BL" && ok "bob: webrtc-фабрика поднялась" || bad "bob: нет webrtc-фабрики"
grep -qa 'медиа-движок = webrtc' "$AL" && ok "alice: движок = реальный webrtc" || bad "alice: не webrtc-движок"
grep -qa 'медиа-движок = webrtc' "$BL" && ok "bob: движок = реальный webrtc" || bad "bob: не webrtc-движок"
grep -qa 'звонок → Active' "$AL" && ok "alice → Active (ICE/DTLS установлен)" || bad "alice не соединилась"
grep -qa 'звонок → Active' "$BL" && ok "bob → Active (ICE/DTLS установлен)" || bad "bob не соединился"

kill -9 "$BOBPID" "$ALICEPID" 2>/dev/null
if [ "$RC" -eq 0 ]; then printf '\033[32mРЕАЛЬНЫЙ ЗВОНОК e2e: СВЯЗЬ УСТАНОВЛЕНА (звук — проверять вживую)\033[0m\n'
else printf '\033[31mРЕАЛЬНЫЙ ЗВОНОК e2e: ЕСТЬ ПРОВАЛЫ\033[0m\n'; fi
exit $RC
