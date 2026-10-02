#!/usr/bin/env bash
# Протокол v2 (spec 007, T064): два десктопа на v2 (PARVANE_PROTO_V2=1).
# alice — gateway по TCP (преамбула PVN2), bob — по WebSocket (двоичные кадры).
# Проверяет: обе v2-сессии поднялись (устройство + журнал), отправка ШТАТНЫМ
# путём уходит по v2 (маршрутизация по журналу собеседника), текст в обе
# стороны, вид, которого клиент не знает, — нативная заглушка unsupported,
# доставка офлайн-устройству и восстановление v2-состояния после рестарта,
# правка своего сообщения по v2, история после рестарта.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
# Диск медленный: identity/messenger поднимаются дольше, чем sleep в stack_start —
# клиент, пришедший раньше, получает таймаут входа и не повторяет его.
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A="$SB/alice"; B="$SB/bob"
AL="$A/td/log.txt"; BL="$B/td/log.txt"
WS_URL='ws://127.0.0.1:9222/ws'

PA=$(start_client "$A" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=bob@local:v2-a1-$S|{\"contact\":{\"first_name\":\"Ivan\"}}")
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  PARVANE_GATEWAY_URL="$WS_URL" "PARVANE_AUTOSEND_V2=alice@local:v2-b1-$S")

wait_log "$AL" "v2: готов" 90 && ok "alice: v2-сессия готова (TCP PVN2)" || bad "alice: v2 не поднялся"
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова (WebSocket)" || bad "bob: v2 не поднялся"
grep -q "v2: устройство создано" "$AL" && ok "alice: устройство и журнал v2 созданы" || bad "alice: устройство v2 не создано"

wait_log "$AL" "v2 → bob@local msg [0-9a-f-]+ \(text\)" 90 && ok "alice → bob ушло по v2 (штатный путь отправки)" \
  || bad "alice → bob не ушло по v2"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): v2-a1-$S" 60 && ok "bob получил текст alice" \
  || bad "bob не получил текст alice"
grep -qE "v2 ← alice@local msg" "$BL" && ok "bob: приём через движок v2" || bad "bob: нет приёма v2"
wait_log "$BL" "v2 → alice@local msg [0-9a-f-]+ \(text\)" 60 && ok "bob → alice ушло по v2" \
  || bad "bob → alice не ушло по v2"
wait_log "$AL" "входящее msg [0-9a-f-]+ \(bob@local\): v2-b1-$S" 60 && ok "alice получила текст bob" \
  || bad "alice не получила текст bob"
wait_log "$BL" "заглушка unsupported msg" 60 && ok "неизвестный клиенту вид → нативная заглушка unsupported" \
  || bad "нет заглушки unsupported"
if grep -qE "E2E не удался|НЕ расшифровано|запись не открыта" "$AL" "$BL"; then
  bad "в логах есть сбои E2E/записей v2"
else
  ok "сбоев E2E и записей v2 нет"
fi

# Офлайн + рестарт: bob гаснет, alice (перезапуск) пишет и правит; bob
# поднимается из сохранённого v2-состояния и догоняет.
stop_pid "$PB"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=bob@local:v2-a2-$S" "PARVANE_AUTOEDIT=25:v2-a2-edited-$S")
wait_log "$AL" "v2: состояние устройства загружено" 90 && ok "alice: v2-состояние загружено после рестарта" \
  || bad "alice: v2-состояние не загружено"
wait_log "$AL" "v2 → bob@local msg [0-9a-f-]+ \(text\)" 90 && ok "alice → офлайн bob по v2" || bad "alice → офлайн bob не ушло"
wait_log "$AL" "v2 → bob@local edit для" 60 && ok "правка своего сообщения ушла по v2" || bad "правка не ушла по v2"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 PARVANE_GATEWAY_URL="$WS_URL")
wait_log "$BL" "v2: состояние устройства загружено" 90 && ok "bob: v2-состояние загружено после рестарта" \
  || bad "bob: v2-состояние не загружено"
wait_log "$BL" "история: воспроизведено" 60 && grep -qE "\(alice@local\): v2-a1-$S" "$BL" \
  && ok "bob: история v2 после рестарта на месте" || bad "bob: история v2 после рестарта не видна"
wait_log "$BL" "\(alice@local\): v2-a2-edited-$S|входящее msg [0-9a-f-]+ \(alice@local\): v2-a2-$S" 60 \
  && ok "bob догнал сообщение, отправленное офлайн" || bad "bob не догнал офлайн-сообщение"
wait_log "$BL" "правка применена msg|\(alice@local\): v2-a2-edited-$S" 60 && ok "bob: правка v2 применена" \
  || bad "bob: правка v2 не применена"
if grep -cE "входящее msg [0-9a-f-]+ \(alice@local\): v2-a1-$S" "$BL" | grep -qv '^[01]$'; then
  bad "bob: сообщение v2 показано повторно после рестарта"
else
  ok "без повторов после рестарта"
fi

stop_pid "$PA"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2"
