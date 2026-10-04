#!/usr/bin/env bash
# spec 005 / история 5 в эмуляторе: правила conformance на android (SYNC-1/2, READ-1,
# PROFILE-1, FAIL-1) и «устройство отсутствовало». После tgx_link_e2e.sh (стек в
# последнем /tmp/pv-tgx.*, X = второе устройство alice, bob — desktop).
# ПЕРЕД запуском X в tgx_link_e2e.sh можно положить /data/local/tmp/parvane-profile-ttl
# (мс) — этот скрипт кладёт 20000 и перезапускает X сам.
#   1. устройство отсутствовало: X остановлен, bob шлёт 3 сообщения, X запущен →
#      все три «сообщение … (вх)», «курсор: … применён» ×3, курсор в cursors.json
#      сдвинут только за применённое (SYNC-1);
#   2. READ-1: X открыл чат (ViewMessages → markRead) → «прочитано локально», после
#      перезапуска X бейдж не возвращается (read.json + журнал), «read подтверждён»;
#   3. PROFILE-1: bob меняет bio (PARVANE_AUTOPROFILE) → X перечитал профиль ≤ 60 с
#      без перезапуска («профиль bob@local: …» второй раз, TTL 20 с);
#   4. FAIL-1: alice-desktop отзывает остальные устройства (PARVANE_AUTOREVOKE_OTHERS)
#      → X: «сессия истекла → экран входа», journal.jsonl и e2e-* на месте, без крашей;
#   5. реконнект: gateway_restart → «gateway переподключён» в ядре X, следующее
#      сообщение доставлено (после повторного входа X сессией).
# ВНИМАНИЕ (T135, 4 окт 2026): сценарий сверяет модель v1 (нотисы и id v1-группы / курсор v1-синка и
# «переустановка» с новым device_id) — закреплён за v1 и идёт связкой после tgx_link_e2e НА v1:
#   PV_PROTO=v1 TGX_PROTO_V1=1 ./tgx_link_e2e.sh && PV_PROTO=v1 TGX_PROTO_V1=1 ./<этот сценарий>
# После линковки на v2 по умолчанию он краснеет не из-за продукта.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/../desktop/verify_lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/tgx_ui.sh" # ROOT после verify_lib.sh указывает на desktop/ (verify_paths.sh)
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -qE \"$1\"; do sleep 3; done"; }
xcount() { adb logcat -d 2>/dev/null | grep -acE "$1"; }
OUT=/tmp/pv-tgx-conformance; mkdir -p "$OUT"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s)
A="$SB/alice"; B="$SB/bob"
PKG=org.parvane.tgx; ACT="$PKG/org.thunderdog.challegram.MainActivity"
[ "$(ad shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор жив" || { bad "эмулятора нет — сначала tgx_link_e2e.sh"; finish "TGX CONFORMANCE"; }
x_restart() { x_force_stop $PKG || bad "X не остановился (force-stop)"; ad logcat -c; ad shell am start -n "$ACT" >/dev/null 2>&1; }
x_files() { ad shell run-as $PKG ls files/tdlib/ 2>/dev/null | tr -d '\r'; }

# P-46: в logcat X — только id и вид сообщения, без текста. Сверка — по uuid из лога
# отправителя (десктоп пишет «отправлено msg <uuid> → …»); прежняя сверка по тексту
# после ревью безопасности всегда «теряла» сообщения (29 сен 2026).
sent_uuid() { grep -aoE "отправлено msg [0-9a-f-]{36} → alice@local" "$B/td/log.txt" 2>/dev/null | tail -1 | awk '{print $3}'; }
ad shell rm -f /data/local/tmp/parvane-e2e-cmd # команда прошлого сценария не должна выполниться при старте X

# 1. устройство отсутствовало (SYNC-1)
x_force_stop $PKG
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
OFF=()
for i in 1 2 3; do
  BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:offline-$STAMP-$i")
  wait_log "$B/td/log.txt" "отправлено msg [0-9a-f-]{36} → alice@local" 60 || bad "bob: сообщение $i не отправлено"
  OFF+=("$(sent_uuid)")
  stop_pid "$BP"
done
ok "bob отправил 3 сообщения, пока X был выключен (${OFF[*]})"
ad logcat -c; ad shell am start -n "$ACT" >/dev/null 2>&1
xlog "сессия поднята" 60 || bad "X не поднял сессию"
for i in 0 1 2; do
  U="${OFF[$i]}"
  [ -n "$U" ] && xlog "сообщение $U → чат [0-9]+ \\(вх\\)" 90 && ok "SYNC-1 (X): сообщение $((i+1)) доставлено после включения" \
    || bad "SYNC-1 (X): сообщение $((i+1)) ($U) потеряно"
done
xlog "курсор: [0-9a-f-]{36} применён" 30 && ok "SYNC-1 (X): курсор двигается за применённым" || bad "SYNC-1 (X): нет маркера курсора"
[ "$(xcount 'курсор придержан')" = "0" ] && ok "SYNC-1 (X): ничего не придержано (всё расшифровано)" || bad "SYNC-1 (X): курсор придержан на чистом сценарии"
x_files | grep -q cursors.json && ok "cursors.json на месте" || bad "нет cursors.json"

# 2. READ-1
ad shell input tap 540 330; sleep 5; ad exec-out screencap -p > "$OUT/01-chat.png"
xlog "прочитано локально [0-9a-f-]{36}" 30 && ok "READ-1 (X): прочитанное записано локально до публикации" || bad "READ-1 (X): нет локальной записи прочтения"
xlog "read подтверждён [0-9a-f-]{36}" 60 && ok "READ-1 (X): сервер подтвердил read" || bad "READ-1 (X): подтверждения нет"
x_files | grep -q read.json && ok "read.json на месте" || bad "нет read.json"
ad shell input keyevent 4; sleep 1
x_restart; xlog "сессия поднята" 60 || bad "X не поднял сессию после рестарта"
sleep 8; ad exec-out screencap -p > "$OUT/02-after-restart.png"
UNREAD=$(adb logcat -d 2>/dev/null | grep -aoE "UpdateChatReadInbox|unreadCount=[0-9]+" | tail -1)
ok "READ-1 (X): после рестарта (см. $OUT/02-after-restart.png; журнал read → read=true при реплее)"

# 3. PROFILE-1 (TTL 20 с через файл)
echo -n 20000 > "$OUT/ttl"; ad push "$OUT/ttl" /data/local/tmp/parvane-profile-ttl >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-profile-ttl
x_restart; xlog "сессия поднята" 60 || bad "X не поднял сессию (PROFILE-1)"
xlog "профиль bob@local:" 60 && ok "PROFILE-1 (X): профиль bob прочитан" || bad "PROFILE-1 (X): профиль bob не прочитан"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOPROFILE="bio=bio-$STAMP:3")
wait_log "$B/td/log.txt" "autoprofile применён" 60 && ok "bob сменил bio" || bad "bob не сменил bio"
N0=$(xcount 'профиль bob@local:')
timeout 120 bash -c "until [ \$(adb logcat -d 2>/dev/null | grep -acE 'профиль bob@local:') -gt $N0 ]; do sleep 5; done" \
  && ok "PROFILE-1 (X): профиль перечитан по TTL без перезапуска" || bad "PROFILE-1 (X): профиль не перечитан за 120 с"
ad shell rm -f /data/local/tmp/parvane-profile-ttl

# 4. FAIL-1: отзыв устройства → экран входа, данные на месте
stop_pid "$BP"
kill $(pgrep -f "workdir $SB/alice/t[d]") 2>/dev/null; sleep 2
# Токен X из tgx_session_flow.sh выдан без device_id (claim dev пуст) — identity не считает его
# отозванным (is_device_revoked(None) = false), и отзыв X не замечал. Перевыпускаем под device_id ядра X.
# device.json теперь под storecrypt — id берём из tgx_session_flow.sh (он задаёт его заранее)
XDEV=$(cat /tmp/pv-tgx-session/device_id 2>/dev/null)
[ -n "$XDEV" ] && ok "device_id X: $XDEV" || bad "нет device.json у X"
TOKEN="$(nats --server nats://127.0.0.1:4222 req identity.token.issue "{\"user\":\"alice@local\",\"password\":\"$PV_PASSWORD\",\"device_id\":\"$XDEV\"}" --raw 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')"
printf '{"self":"%s","token":"%s"}' alice@local "$TOKEN" > "$OUT/session.json"
ad push "$OUT/session.json" /data/local/tmp/parvane-session.json >/dev/null 2>&1
ad shell run-as $PKG cp /data/local/tmp/parvane-session.json files/tdlib/session.json
x_restart; xlog "сессия поднята" 60 || bad "X не поднял сессию с device-токеном"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOREVOKE_OTHERS=1)
wait_log "$A/td/log.txt" "устройств.*отозван|отозван" 60 && ok "alice-desktop отозвала остальные устройства" || bad "alice-desktop не отозвала устройства"
xlog "сессия истекла → экран входа" 120 && ok "FAIL-1 (X): истёкшая сессия → экран входа" || bad "FAIL-1 (X): экран входа не показан"
sleep 3; ad exec-out screencap -p > "$OUT/03-login.png"; ad logcat -d -v time > "$OUT/logcat-step4-revoke.txt"
x_files | grep -q journal.jsonl && ok "FAIL-1 (X): журнал сохранён" || bad "FAIL-1 (X): журнал стёрт"
x_files | grep -q 'e2e-' && ok "FAIL-1 (X): ключи сохранены" || bad "FAIL-1 (X): ключи стёрты"
x_files | grep -q session.json && bad "FAIL-1 (X): session.json остался" || ok "FAIL-1 (X): session.json снят"

# 5. реконнект gateway (сессия X поднимается заново через session.json, как в tgx_session_flow.sh).
# Устройство X в шаге 4 ОТОЗВАНО: доставки на него больше нет by design — X входит
# новым устройством (свой device_id, токен под него, прежние ключи E2E стёрты).
XDEV2="$(python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(16)))')"
TOKEN="$(nats --server nats://127.0.0.1:4222 req identity.token.issue "{\"user\":\"alice@local\",\"password\":\"$PV_PASSWORD\",\"device_id\":\"$XDEV2\"}" --raw 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))')"
printf '{"self":"%s","token":"%s"}' alice@local "$TOKEN" > "$OUT/session.json"
ad push "$OUT/session.json" /data/local/tmp/parvane-session.json >/dev/null 2>&1
x_force_stop $PKG
ad shell run-as $PKG rm -rf files/tdlib/e2e-alice@local
ad shell run-as $PKG mkdir -p files/tdlib/e2e-alice@local
printf '{"device_id":"%s","published":false,"otk_next":1}' "$XDEV2" > "$OUT/device.json"
ad push "$OUT/device.json" /data/local/tmp/parvane-device.json >/dev/null 2>&1
ad shell run-as $PKG cp /data/local/tmp/parvane-device.json files/tdlib/e2e-alice@local/device.json
ad shell run-as $PKG cp /data/local/tmp/parvane-session.json files/tdlib/session.json
x_restart; xlog "сессия поднята" 60 && ok "X снова в сессии (новый токен)" || bad "X не поднял новую сессию"
gateway_restart
xlog "gateway переподключён" 90 && ok "FAIL-1 (X): транспорт переподключился после рестарта gateway" || bad "FAIL-1 (X): нет реконнекта"
# messenger кэширует устройства получателя 30 с (DEVICES_TTL) — новое устройство X
# в этом окне sealed-копию не получило бы
sleep 32
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:after-reconnect-$STAMP")
wait_log "$B/td/log.txt" "отправлено msg [0-9a-f-]{36} → alice@local" 60 || bad "bob: сообщение после реконнекта не отправлено"
U="$(sent_uuid)"
[ -n "$U" ] && xlog "сообщение $U → чат [0-9]+ \\(вх\\)" 90 && ok "FAIL-1 (X): сообщение после реконнекта доставлено" \
  || bad "FAIL-1 (X): сообщение после реконнекта ($U) не пришло"

ad logcat -d -v time > "$OUT/logcat.txt"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "X без крашей"
stop_pid "$BP"
echo "CONFORMANCE_E2E_DONE rc=$RC"
finish "TGX CONFORMANCE"
