#!/usr/bin/env bash
# Parvane — e2e РЕАЛЬНОГО звонка (webrtc, Э3-b) между двумя экземплярами форка.
# PARVANE_REAL_MEDIA=1 → настоящий webrtc::PeerConnection (tg_owt) вместо заглушки.
# Проверяем, что webrtc-фабрика поднимается и между двумя экземплярами реально
# устанавливается ICE/DTLS-соединение (оба доходят до Active из webrtc-колбэка
# OnConnectionChange(kConnected)). САМ ЗВУК headless не проверить — только связь.
# Сигналы — конверты v2 через gateway; перед звонком — обмен сообщениями (D-08).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-call-real}"
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"

pair_exchange "$A" alice@local "$B" bob@local
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 PARVANE_AUTOACCEPT=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 PARVANE_AUTOCALL=bob@local)

for _ in $(seq 1 60); do
  grep -qa 'звонок → Active' "$AL" 2>/dev/null && grep -qa 'звонок → Active' "$BL" 2>/dev/null && break
  sleep 1
done

grep -qa 'webrtc-фабрика создана, ok=1' "$AL" && ok "alice: webrtc-фабрика поднялась" || bad "alice: нет webrtc-фабрики"
grep -qa 'webrtc-фабрика создана, ok=1' "$BL" && ok "bob: webrtc-фабрика поднялась" || bad "bob: нет webrtc-фабрики"
grep -qa 'медиа-движок = webrtc' "$AL" && ok "alice: движок = реальный webrtc" || bad "alice: не webrtc-движок"
grep -qa 'медиа-движок = webrtc' "$BL" && ok "bob: движок = реальный webrtc" || bad "bob: не webrtc-движок"
grep -qa 'звонок → Active' "$AL" && ok "alice → Active (ICE/DTLS установлен)" || bad "alice не соединилась"
grep -qa 'звонок → Active' "$BL" && ok "bob → Active (ICE/DTLS установлен)" || bad "bob не соединился"

stop_pid "$AP"; stop_pid "$BP"; stack_stop
finish "РЕАЛЬНЫЙ ЗВОНОК e2e (звук — проверять вживую)"
