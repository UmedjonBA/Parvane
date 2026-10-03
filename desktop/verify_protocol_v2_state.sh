#!/usr/bin/env bash
# Протокол v2 (spec 007, T132/T133; FR-039, FR-040, FR-033): личное состояние
# между двумя устройствами одного аккаунта и отзыв доступа у заблокированного.
# alice1 и alice2 (привязано грантом) — на v2, bob — собеседник на v2.
#  • настройки уведомлений, закреп, архив и блок-лист, заданные на alice1,
#    приходят на alice2 из журнала личного состояния ≤ 10 с (SC-009);
#  • приватность («сообщения от незнакомых») хранит сервер: alice2 после
#    перезапуска читает её с сервера (FR-040);
#  • блокировка bob меняет ключ доступа к доставке alice (FR-033): по прежнему
#    ключу сервер bob не пускает, незнакомым закрыто — сообщение не доходит.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-state"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"

PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOSEND_V2=bob@local:знакомство-$S")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова" || bad "alice1: v2 не поднялся"
wait_log "$L1" "жетоны: партия по расписанию получена" 30 && ok "alice1: партия жетонов получена заранее (FR-063)" \
  || bad "alice1: партии жетонов по расписанию нет"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): знакомство-$S" 60 \
  && ok "bob получил текст alice1 (ключ доступа alice роздан)" || bad "bob не получил текст alice1"

# bob отвечает — у alice появляется чат с bob (его можно закрепить и убрать в архив)
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:ответ-$S")
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): ответ-$S" 90 && ok "alice1 получила ответ bob по v2" \
  || bad "alice1 не получила ответ bob"

# ── второе устройство alice ──────────────────────────────────────────────────
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1)
wait_log "$L2" "v2: устройство привязано грантом линковки" 150 && ok "alice2 привязана грантом" || bad "alice2 не привязана"
wait_log "$L2" "журнал личного состояния подключён" 90 && ok "alice2: журнал состояния подключён" \
  || bad "alice2: журнал состояния не подключён"

# ── правки на alice1 → alice2 из журнала ≤ 10 с ──────────────────────────────
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOSTRANGERS=off@14" "PARVANE_AUTOMUTE=bob@local:18" \
  "PARVANE_AUTOSTATE=pin:bob@local@28,archive:bob@local@40,block:bob@local@52")
wait_log "$L1" "журнал личного состояния подключён" 90 && ok "alice1: журнал состояния подключён после рестарта" \
  || bad "alice1: журнал состояния не подключён"
wait_log "$L1" "приватность сохранена: незнакомые нет" 60 && ok "alice1: приватность сохранена на сервере" \
  || bad "alice1: приватность не сохранена"

wait_log "$L1" "automute → bob@local" 60 && ok "alice1: bob заглушён" || bad "alice1: мут не сработал"
wait_log "$L2" "журнал состояния → уведомления \([1-9][0-9]* изменений\)" 12 \
  && ok "alice2: настройки уведомлений пришли из журнала ≤ 10 с" || bad "alice2: мут из журнала не пришёл"
wait_log "$L2" "уведомления с другого устройства: bob@local mutedUntil=[1-9]" 5 \
  && ok "alice2: bob заглушён нативно" || bad "alice2: мут не применён"

wait_log "$L1" "autostate pin → bob@local" 60 && ok "alice1: чат с bob закреплён" || bad "alice1: закреп не сработал"
wait_log "$L2" "журнал состояния → архив 0, закреплено 1" 12 && ok "alice2: закреп пришёл из журнала ≤ 10 с" \
  || bad "alice2: закреп из журнала не пришёл"

wait_log "$L1" "autostate archive → bob@local" 60 && ok "alice1: чат с bob в архиве" || bad "alice1: архив не сработал"
wait_log "$L2" "журнал состояния → архив 1, закреплено 0" 12 && ok "alice2: архив пришёл из журнала ≤ 10 с" \
  || bad "alice2: архив из журнала не пришёл"

wait_log "$L1" "autostate block → bob@local" 60 && ok "alice1: bob заблокирован" || bad "alice1: блокировка не сработала"
wait_log "$L2" "журнал состояния → блок-лист \(1 изменений\)" 12 && ok "alice2: блок-лист пришёл из журнала ≤ 10 с" \
  || bad "alice2: блок-лист из журнала не пришёл"
wait_log "$L1" "доступ заблокированного отозван \(ключ доступа сменён\)" 30 \
  && ok "alice1: ключ доступа к доставке сменён (FR-033)" || bad "alice1: доступ заблокированного не отозван"

# v1-блоб настроек уведомлений не раскрывает серверу, кто заглушён (FR-039)
if command -v sqlite3 >/dev/null; then
  BLOB=$(sqlite3 "$SB/messenger.db" "SELECT notify_json FROM user_settings WHERE user='alice@local'" 2>/dev/null)
  case "$BLOB" in
    *bob@local*) bad "v1-блоб настроек содержит адрес заглушённого чата" ;;
    *) ok "v1-блоб настроек не содержит заглушённых чатов" ;;
  esac
fi

# ── приватность читается с сервера на другом устройстве (FR-040) ─────────────
stop_pid "$P2"
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1)
wait_log "$L2" "приватность с сервера: незнакомые нет" 90 \
  && ok "alice2: приватность прочитана с сервера после перезапуска" || bad "alice2: приватность с сервера не прочитана"

# ── заблокированный: прежний ключ доступа не действует, незнакомым закрыто ────
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:после-блока-$S")
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся после рестарта"
sleep 20
if grep -qE "входящее msg [0-9a-f-]+ \(bob@local\): после-блока-$S" "$L1" "$L2"; then
  bad "сообщение заблокированного дошло до alice"
else
  ok "сообщение заблокированного до alice не дошло (ключ отозван, незнакомым закрыто)"
fi
grep -qE "v2 → alice@local msg [0-9a-f-]+ \(text\)" "$BL" \
  && bad "bob считает сообщение отправленным по v2" || ok "bob: отправка отклонена сервером"

if grep -qE "запись не открыта|ошибка записи|E2E не удался" "$L1" "$L2"; then
  bad "в логах alice есть сбои записей v2"
else
  ok "сбоев записей v2 нет"
fi
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_state"
