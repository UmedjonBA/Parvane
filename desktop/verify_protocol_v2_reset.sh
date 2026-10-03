#!/usr/bin/env bash
# Протокол v2 (spec 007, T129/T130, FR-019/FR-066): сброс личности на новом
# устройстве и смена корня глазами собеседника (KEY-1 v2).
# alice1 — первое v2-устройство, потеряно. alice2 — новое устройство: журнал
# устройств у аккаунта есть, других устройств нет → сброс личности (хук
# PARVANE_AUTORESET, пароль из PARVANE_AUTOLOGIN): новый корень и журнал.
# bob при следующей отправке видит, что журнал alice начат заново, показывает
# «ключ безопасности изменился» и доставляет сообщение новому устройству.
# Прежнее устройство alice1 сервер при сбросе отзывает (сессии v1/v2, каталог
# v1): войти оно не может и копий сообщений не получает.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-reset"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"

PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=bob@local:до-сброса-$S")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова (первое устройство)" || bad "alice1: v2 не поднялся"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): до-сброса-$S" 60 && ok "bob получил текст alice1 по v2" \
  || bad "bob не получил текст alice1"
stop_pid "$P1" # устройство «потеряно»

# ── новое устройство: других устройств нет, ключа восстановления нет → сброс ──
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 PARVANE_AUTORESET=1)
wait_log "$L2" "v2: у аккаунта уже есть журнал устройств — нужна линковка" 90 \
  && ok "alice2: журнал устройств уже есть" || bad "alice2: нет состояния «нужна линковка»"
wait_log "$L2" "v2: личность сброшена — новый корень и журнал устройств" 60 && ok "alice2: личность сброшена" \
  || bad "alice2: сброс личности не выполнен"
wait_log "$L2" "v2: autoreset → ok" 30 && ok "alice2: сброс подтверждён" || bad "alice2: autoreset не ok"
wait_log "$L2" "v2: готов" 90 && ok "alice2: v2-сессия готова на новой личности" || bad "alice2: v2 не поднялся"
grep -q "смена корня у alice@local" "$SB/identity.log" && ok "сервер: журнал устройств alice начат заново" \
  || bad "сервер не отметил смену корня"

# ── bob: смена корня собеседника (KEY-1 v2) и доставка новому устройству ──────
sleep 17 # bob перечитывает журнал alice раз в 15 с
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:после-сброса-$S")
wait_log "$BL" "v2: у alice@local сменился корневой ключ — предупреждение в чате" 90 \
  && ok "bob: смена корня alice замечена, предупреждение показано" || bad "bob не заметил смену корня"
wait_log "$BL" "v2 → alice@local msg [0-9a-f-]+ \(text\)" 90 && ok "bob → alice ушло по v2" || bad "bob → alice не ушло по v2"
wait_log "$L2" "входящее msg [0-9a-f-]+ \(bob@local\): после-сброса-$S" 60 && ok "alice2 прочитала (новая личность)" \
  || bad "alice2 не прочитала сообщение после сброса"

# ── прежнее устройство вне новой личности: сервер отозвал его при сбросе ──────
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$L1" "авторизация отклонена .*устройство отозвано" 90 \
  && ok "alice1: прежнее устройство отозвано сбросом личности" || bad "alice1 по-прежнему входит"
# В каталоге v1 — только устройство новой личности (его v1-бандл принят как
# бандл устройства журнала v2, T146); прежнее удалено и в список v1-устройств
# новой личности не попадёт
N=$(sqlite3 "$SB/identity.db" "SELECT COUNT(*) FROM device_keys WHERE username='alice@local';")
OLD=$(sqlite3 "$SB/identity.db" "ATTACH '$SB/identity.db-v2.db' AS v2; SELECT COUNT(*) FROM device_keys k WHERE k.username='alice@local' AND k.device_id NOT IN (SELECT device_id FROM v2.device_state WHERE user='alice@local' AND revoked=0);")
[ "$N" -le 1 ] && [ "$OLD" = "0" ] && ok "каталог v1: прежнее устройство удалено (устройств: $N, вне журнала v2: 0)" \
  || bad "device_keys alice: $N (вне журнала v2: $OLD)"
grep -q "список v1-устройств опубликован" "$L2" && bad "новая личность внесла потерянное устройство в список v1-устройств" \
  || ok "список v1-устройств новой личности пуст"
sleep 3
grep -q "входящее msg .* (bob@local): после-сброса-$S" "$L1" && bad "прежнее устройство прочитало новое сообщение" \
  || ok "прежнее устройство новое сообщение НЕ читает"

grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_reset"
