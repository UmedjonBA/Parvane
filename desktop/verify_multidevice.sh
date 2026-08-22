#!/usr/bin/env bash
# Parvane desktop — МУЛЬТИДЕВАЙС: один аккаунт bob на двух desktop-экземплярах.
#  1) оба устройства bob публикуют СВОИ бандлы (device_keys: 2 строки, разные id);
#  2) alice → bob: читают ОБА устройства (fan-out копий, message_device_copies);
#  3) bob1 → alice: alice читает; bob2 видит его как СВОЁ исходящее (self-копия
#     по signing_key + подписанный sync).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-mdev}"
STAMP=$(date +%s); T1="от-alice-$STAMP"; T2="от-bob1-$STAMP"
B1="$SB/bob1"; B2="$SB/bob2"; A="$SB/alice"
P1=$(start_client "$B1" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B1/td/log.txt" "E2E-устройство готово" 40 || bad "bob1 не поднялся"
P2=$(start_client "$B2" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B2/td/log.txt" "E2E-устройство готово" 40 || bad "bob2 не поднялся"
sleep 2
N=$(sqlite3 "$SB/identity.db" "SELECT COUNT(DISTINCT device_id) FROM device_keys WHERE username='bob@local';")
[ "$N" = "2" ] && ok "у bob 2 устройства в identity (device_id разные)" || bad "device_keys bob: $N (ожидалось 2)"
SK=$(sqlite3 "$SB/identity.db" "SELECT COUNT(*) FROM device_keys WHERE username='bob@local' AND signing_key<>'';")
[ "$SK" = "2" ] && ok "оба устройства несут signing_key" || bad "signing_key пуст ($SK/2)"

PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T1")
wait_log "$B1/td/log.txt" "входящее msg .* \(alice@local\): $T1" 60 && ok "bob1 получил от alice" || bad "bob1 не получил"
wait_log "$B2/td/log.txt" "входящее msg .* \(alice@local\): $T1" 30 && ok "bob2 получил от alice (fan-out)" || bad "bob2 не получил"
C=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM message_device_copies WHERE recipient='bob@local';")
[ "${C:-0}" -ge 2 ] && ok "message_device_copies: $C копий для bob" || bad "копий для bob: ${C:-0}"
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind<>'encrypted' AND kind<>'group_encrypted';")
[ "${K:-0}" = "0" ] && ok "на сервере только шифртекст" || bad "плейнтекст на сервере: $K"
grep -q "ОТКЛОНЕНО" "$B1/td/log.txt" "$B2/td/log.txt" "$A/td/log.txt" && bad "ложная подмена отправителя" || ok "верификация отправителя: без ложных срабатываний"

# bob1 шлёт alice (рестарт в том же workdir — устройство персистно).
stop_pid "$P1"
P1=$(start_client "$B1" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:$T2")
wait_log "$A/td/log.txt" "входящее msg .* \(bob@local\): $T2" 60 && ok "alice получила от bob1" || bad "alice не получила bob1"
wait_log "$B2/td/log.txt" "своё msg .* \(alice@local\): $T2" 40 && ok "bob2 видит исходящее bob1 как своё (self-копия)" || bad "bob2 не видит исходящее bob1"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B1/td/log.txt" "$B2/td/log.txt" && bad "фатальная ошибка в логе" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PA"; stack_stop
finish "МУЛЬТИДЕВАЙС"
