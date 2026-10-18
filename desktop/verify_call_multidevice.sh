#!/usr/bin/env bash
# Parvane — звонок пользователю, у которого ДВА устройства (spec 024/029).
# d2 — второе устройство bob, привязанное грантом d1 (журнал устройств v2).
# Сигналы звонка — запечатанные конверты на все устройства журнала bob,
# отправителя проверяет движок (подписи SDP ключом звонков нет). Звонить в v2
# можно только тому, кто тебе уже писал (ключ доступа, D-08) — bob сначала пишет
# alice. Сценарий:
#   1) alice заводит журнал устройств; bob d1 пишет ей (ключ доступа bob у alice);
#   2) bob d2 привязывается грантом от d1;
#   3) alice звонит bob; звонят ОБА устройства, d2 авто-принимает; alice и d2
#      доходят до Active, а d1 — гасит у себя входящий (ответ на другом устройстве).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-callmd}"
STAMP="$(date +%s)"
A="$SB/alice"; B1="$SB/bob1"; B2="$SB/bob2"
AL="$A/td/log.txt"; L1="$B1/td/log.txt"; L2="$B2/td/log.txt"

# 1) alice регистрируется и гаснет; bob d1 пишет ей
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$AL" "v2: готов" 90 && ok "alice: v2-сессия готова" || bad "alice: v2 не поднялся"
B1P=$(start_client "$B1" bob@local "${PV_DEV_OLD[@]}" "PARVANE_AUTOSEND=alice@local:перед-звонком-$STAMP")
wait_log "$L1" "v2: готов" 90 && ok "bob d1: v2-сессия готова" || bad "bob d1: v2 не поднялся"
wait_log "$AL" "входящее msg .* \(bob@local\): перед-звонком-$STAMP" 90 \
  && ok "alice получила сообщение bob (ключ доступа bob у alice)" || bad "alice не получила сообщение bob"
stop_pid "$AP"
# 2) d2 — второе устройство bob: привязка грантом от d1
B2P=$(start_client "$B2" bob@local "${PV_DEV_NEW[@]}" PARVANE_AUTOACCEPT=1)
wait_linked "$L2" && ok "bob d2 привязан грантом линковки" || bad "bob d2 не привязан"
# d1 перезапускается без своего autosend — звонит у обоих устройств
stop_pid "$B1P"
B1P=$(start_client "$B1" bob@local "${PV_DEV_OLD[@]}")
wait_log "$L1" "v2: готов" 90 || bad "bob d1: v2 после рестарта не поднялся"

# 3) alice звонит bob
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOCALL=bob@local)
wait_log "$L2" "ВХОДЯЩИЙ звонок от alice@local" 60 && ok "bob d2: входящий звонок от alice" || bad "bob d2 не получил входящий"
for _ in $(seq 1 60); do
  grep -qa "звонок → Active" "$AL" 2>/dev/null && grep -qa "звонок → Active" "$L2" 2>/dev/null && break
  sleep 1
done
grep -qa "звонок → Active" "$AL" && ok "alice → Active" || bad "alice не дошла до Active"
grep -qa "звонок → Active" "$L2" && ok "bob d2 → Active (сигналы на устройство журнала)" || bad "bob d2 не дошёл до Active"
grep -qa "ВХОДЯЩИЙ звонок от alice@local" "$L1" && ok "bob d1: входящий тоже звонил" || bad "bob d1: входящего не было"
grep -qa "звонок → Active" "$L1" && bad "bob d1 тоже соединился (два ответа)" || ok "bob d1 не соединялся (ответ на другом устройстве)"
grep -qiE "Fatal|Unexpected in " "$AL" "$L1" "$L2" && bad "фатальные ошибки" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$B1P"; stop_pid "$B2P"; stack_stop
finish "ЗВОНОК МУЛЬТИДЕВАЙС"
