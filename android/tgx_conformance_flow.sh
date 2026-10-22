#!/usr/bin/env bash
# Правила conformance на X поверх v2 (spec 031): SYNC-1, READ-1, PROFILE-1, FAIL-1 и переподключение.
# После tgx_protocol_link_flow.sh (стек в последнем /tmp/pv-tgx.*, X — второе устройство alice, alice-desktop —
# первое, bob — desktop). Сверка — по uuid из лога отправителя (в logcat X текста нет, P-46).
#   1. SYNC-1: X выключен, bob шлёт 3 сообщения → после запуска X все три в чате (инбокс v2 сохранил их);
#   2. READ-1: X открывает чат → bob видит «своё прочитано ✓✓»; после перезапуска X счётчик не возвращается;
#   3. PROFILE-1: bob меняет bio → X перечитывает профиль по TTL (20 с через файл) без перезапуска;
#   4. переподключение: gateway перезапущен → X снова на связи, следующее сообщение доставлено;
#   5. FAIL-1: alice-desktop отзывает остальные устройства → X: «сессия истекла → экран входа».
#   ./tgx_conformance_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-conformance}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"
S=$(date +%s)
sent_uuid() { grep -aoE "отправлено msg [0-9a-f-]{36} → alice@local" "$BL" 2>/dev/null | tail -1 | awk '{print $3}'; }
a shell rm -f /data/local/tmp/parvane-e2e-cmd /data/local/tmp/parvane-profile-ttl

# 1. SYNC-1: устройство отсутствовало
tgx_stop
OFF=()
for i in 1 2 3; do
  BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:offline-$S-$i")
  wait_log "$BL" "отправлено msg [0-9a-f-]{36} → alice@local" 60 || bad "bob: сообщение $i не отправлено"
  OFF+=("$(sent_uuid)")
  stop_pid "$BP"
done
ok "bob отправил 3 сообщения, пока X был выключен"
tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"
for i in 0 1 2; do
  U="${OFF[$i]}"
  [ -n "$U" ] && tgx_logwait "сообщение $U → чат [0-9]+ \(вх\)" 90 && ok "SYNC-1 (X): сообщение $((i+1)) доставлено после включения" \
    || bad "SYNC-1 (X): сообщение $((i+1)) ($U) потеряно"
done

# 2. READ-1: прочтение на X → квитанция bob; после перезапуска непрочитанное не возвращается
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
tgx_mark
tgx_cmd '{"op":"read","peer":"bob@local"}' && ok "X: чат bob прочитан (ViewMessages)" || bad "X: прочтение не выполнено"
wait_log "$BL" "своё прочитано ✓✓ msg ${OFF[2]}" 60 && ok "READ-1: bob увидел прочтение X" || bad "READ-1: квитанция X до bob не дошла"
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 || bad "X: сессии нет после перезапуска"
tgx_cmd '{"op":"unread","peer":"bob@local"}' || true
tgx_logwait "непрочитано bob@local: 0" 30 && ok "READ-1 (X): после перезапуска чат прочитан" || bad "READ-1 (X): непрочитанное вернулось"
stop_pid "$BP"

# 3. PROFILE-1: профиль перечитывается по TTL (20 с через файл)
tgx_put parvane-profile-ttl 20000
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 || bad "X: сессии нет (PROFILE-1)"
tgx_logwait "профиль bob@local:" 90 && ok "PROFILE-1 (X): профиль bob прочитан" || bad "PROFILE-1 (X): профиль bob не прочитан"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOPROFILE="bio=bio-$S:3")
wait_log "$BL" "autoprofile применён" 60 && ok "bob сменил bio" || bad "bob не сменил bio"
tgx_mark
tgx_logwait "профиль bob@local:" 120 && ok "PROFILE-1 (X): профиль перечитан по TTL без перезапуска" || bad "PROFILE-1 (X): профиль не перечитан"
a shell rm -f /data/local/tmp/parvane-profile-ttl
stop_pid "$BP"

# 4. переподключение gateway
tgx_mark
gateway_restart
tgx_logwait "v2: (готов|переподключ)" 120 && ok "X: снова на связи после рестарта gateway" || bad "X: не переподключился"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:after-reconnect-$S")
wait_log "$BL" "отправлено msg [0-9a-f-]{36} → alice@local" 60 || bad "bob: сообщение после реконнекта не отправлено"
U="$(sent_uuid)"
[ -n "$U" ] && tgx_logwait "сообщение $U → чат [0-9]+ \(вх\)" 90 && ok "X: сообщение после реконнекта доставлено" \
  || bad "X: сообщение после реконнекта ($U) не пришло"
stop_pid "$BP"

# 5. FAIL-1: отзыв устройства → экран входа
tgx_mark
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOREVOKE_OTHERS=5 "PARVANE_AUTOLOGIN=alice@local:$PV_PASSWORD")
wait_log "$AL" "autorevoke .* → (true|1|ok)" 90 && ok "alice-desktop отозвала остальные устройства" || bad "alice-desktop не отозвала устройства"
tgx_logwait "сессия истекла → экран входа" 120 && ok "FAIL-1 (X): отозванное устройство → экран входа" || bad "FAIL-1 (X): экран входа не показан"
sleep 3; tgx_shot "$OUT/01-login.png"
stop_pid "$AP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX CONFORMANCE"
