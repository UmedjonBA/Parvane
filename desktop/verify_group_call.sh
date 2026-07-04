#!/usr/bin/env bash
# Parvane — e2e ГРУППОВОГО звонка в форке (mesh, без звука). alice создаёт группу
# с bob+carol и стартует групповой звонок; bob и carol авто-подключаются. Проверяем,
# что каждый из троих соединён с двумя другими (полный mesh) по логам onPeerState.
# Требует nats+identity+messenger+call. Медиа — StubMediaBackend (без звука).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }
nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' \
    >/dev/null 2>&1 || { echo "нет бэкенда — запусти nats+identity+messenger+call"; exit 2; }

pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
sleep 2
A=$(mktemp -d /tmp/pv-vgc-a.XXXXXX); B=$(mktemp -d /tmp/pv-vgc-b.XXXXXX); C=$(mktemp -d /tmp/pv-vgc-c.XXXXXX)
run() { QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" "$@"; }
run PARVANE_AUTOLOGIN='bob@local:test'   "$BIN" -workdir "$B/td" >"$B/out.log" 2>&1 &
run PARVANE_AUTOLOGIN='carol@local:test' "$BIN" -workdir "$C/td" >"$C/out.log" 2>&1 &
sleep 3
run PARVANE_AUTOLOGIN='alice@local:test' \
    PARVANE_AUTOGROUP='ГК:bob@local,carol@local' PARVANE_AUTOGROUPCALL='ГК' \
    "$BIN" -workdir "$A/td" >"$A/out.log" 2>&1 &
AL="$A/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
for i in $(seq 1 30); do
    na=$(grep -ac 'groupcall .* Active' "$AL" 2>/dev/null); na=${na:-0}
    nb=$(grep -ac 'groupcall .* Active' "$BL" 2>/dev/null); nb=${nb:-0}
    nc=$(grep -ac 'groupcall .* Active' "$CL" 2>/dev/null); nc=${nc:-0}
    [ "$na" -ge 2 ] && [ "$nb" -ge 2 ] && [ "$nc" -ge 2 ] && break
    sleep 1
done
na=$(grep -ac 'groupcall .* Active' "$AL" 2>/dev/null); na=${na:-0}
nb=$(grep -ac 'groupcall .* Active' "$BL" 2>/dev/null); nb=${nb:-0}
nc=$(grep -ac 'groupcall .* Active' "$CL" 2>/dev/null); nc=${nc:-0}
grep -qa 'групповой звонок начат' "$AL" && ok "alice инициировала групповой звонок" || bad "alice не начала"
[ "$na" -ge 2 ] && ok "alice соединена с 2 участниками (n=$na)" || bad "alice mesh неполный (n=$na)"
[ "$nb" -ge 2 ] && ok "bob соединён с 2 участниками (n=$nb)" || bad "bob mesh неполный (n=$nb)"
[ "$nc" -ge 2 ] && ok "carol соединена с 2 участниками (n=$nc)" || bad "carol mesh неполный (n=$nc)"
pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
if [ "$RC" -eq 0 ]; then printf '\033[32mГРУППОВОЙ ЗВОНОК e2e: ПОЛНЫЙ MESH (звук — вживую)\033[0m\n'
else printf '\033[31mГРУППОВОЙ ЗВОНОК e2e: ПРОВАЛЫ\033[0m\n'; fi
exit $RC
