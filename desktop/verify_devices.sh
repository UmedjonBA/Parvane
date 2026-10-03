#!/usr/bin/env bash
# Parvane desktop — Settings→Devices: список устройств и ОТЗЫВ (identity.device.*).
#  bob1+bob2 зарегистрированы; bob1 отзывает все прочие (AUTOREVOKE_OTHERS);
#  в каталоге остаётся 1 устройство; alice → bob: читает только bob1, bob2
#  (отозван) новые сообщения НЕ расшифровывает.
# Протокол v2 (по умолчанию, T135): bob1 — второе устройство, сначала
# привязывается грантом линковки от bob2, затем отзывает его (запись журнала
# устройств v2, REVOKE-1). PV_PROTO=v1 — прежний путь с каталогом устройств v1.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-devs}"
STAMP=$(date +%s); T1="после-отзыва-$STAMP"
B1="$SB/bob1"; B2="$SB/bob2"; A="$SB/alice"
P2=$(start_client "$B2" bob@local "${PV_DEV_OLD[@]}")
wait_log "$B2/td/log.txt" "E2E-устройство готово" 40 || bad "bob2 не поднялся"
if is_v2; then
  wait_log "$B2/td/log.txt" "v2: готов" 60 || bad "bob2: v2 не поднялся"
  # отзыв — через 40 с после входа: к этому времени bob1 привязан (оффер, код, грант)
  P1=$(start_client "$B1" bob@local "${PV_DEV_NEW[@]}" PARVANE_AUTOREVOKE_OTHERS=40)
  wait_log "$B1/td/log.txt" "E2E-устройство готово" 40 || bad "bob1 не поднялся"
  wait_linked "$B1/td/log.txt" && ok "bob1 привязан грантом линковки" || bad "bob1 не привязан"
  wait_log "$B1/td/log.txt" "устройство .* \[текущее\]" 60 && ok "bob1 видит себя в списке устройств" || bad "список устройств пуст"
  wait_log "$B1/td/log.txt" "autorevoke .* → ok" 60 && ok "bob1 отозвал bob2" || bad "отзыв не удался"
  wait_log "$B1/td/log.txt" "v2: устройство .* отозвано в журнале устройств" 30 && ok "отзыв записан в журнал устройств v2" || bad "записи отзыва v2 нет"
  sleep 1
  N=$(sqlite3 "$SB/identity.db-v2.db" "SELECT COUNT(*) FROM device_state WHERE user='bob@local' AND revoked=0;")
  [ "$N" = "1" ] && ok "в журнале устройств осталось 1 активное устройство bob" || bad "активных устройств bob в журнале: $N"
else
P1=$(start_client "$B1" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOREVOKE_OTHERS=6)
wait_log "$B1/td/log.txt" "E2E-устройство готово" 40 || bad "bob1 не поднялся"
wait_log "$B1/td/log.txt" "устройство .* \[текущее\]" 30 && ok "bob1 видит себя в списке устройств" || bad "список устройств пуст"
wait_log "$B1/td/log.txt" "autorevoke .* → ok" 30 && ok "bob1 отозвал bob2" || bad "отзыв не удался"
sleep 1
N=$(sqlite3 "$SB/identity.db" "SELECT COUNT(*) FROM device_keys WHERE username='bob@local';")
[ "$N" = "1" ] && ok "в каталоге осталось 1 устройство bob" || bad "device_keys bob: $N"
grep -q "групповые ключи ротированы" "$B1/td/log.txt" && ok "ротация ключей после отзыва" || bad "нет ротации"
fi
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T1")
wait_log "$B1/td/log.txt" "входящее msg .* \(alice@local\): $T1" 60 && ok "bob1 читает после отзыва" || bad "bob1 не получил"
sleep 5
grep -q "входящее msg .* (alice@local): $T1" "$B2/td/log.txt" && bad "отозванный bob2 прочитал новое сообщение" || ok "отозванный bob2 НЕ читает новые"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PA"; stack_stop
finish "DEVICES"
