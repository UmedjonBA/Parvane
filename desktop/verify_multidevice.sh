#!/usr/bin/env bash
# Parvane desktop — МУЛЬТИДЕВАЙС: один аккаунт bob на двух desktop-экземплярах.
#  1) оба устройства bob публикуют СВОИ бандлы (device_keys: 2 строки, разные id);
#  2) alice → bob: читают ОБА устройства (fan-out копий, message_device_copies);
#  3) bob1 → alice: alice читает; bob2 видит его как СВОЁ исходящее (self-копия
#     по signing_key + подписанный sync).
# Протокол v2 (по умолчанию, T135): второе устройство привязывается грантом
# линковки (без неё оно в журнал устройств не входит и ничего не получает);
# копии — конверты под каждое устройство журнала, своё исходящее приходит
# копией своим устройствам (D-05). PV_PROTO=v1 — прежний путь и проверки каталога.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-mdev}"
STAMP=$(date +%s); T1="от-alice-$STAMP"; T2="от-bob1-$STAMP"
B1="$SB/bob1"; B2="$SB/bob2"; A="$SB/alice"
P1=$(start_client "$B1" bob@local "${PV_DEV_OLD[@]}")
wait_log "$B1/td/log.txt" "E2E-устройство готово" 40 || bad "bob1 не поднялся"
is_v2 && { wait_log "$B1/td/log.txt" "v2: готов" 60 || bad "bob1: v2 не поднялся"; }
P2=$(start_client "$B2" bob@local "${PV_DEV_NEW[@]}")
wait_log "$B2/td/log.txt" "E2E-устройство готово" 40 || bad "bob2 не поднялся"
sleep 2
if is_v2; then
  wait_linked "$B2/td/log.txt" && ok "bob2 привязан грантом линковки и вошёл в журнал устройств" || bad "bob2 не привязан"
  wait_log "$B1/td/log.txt" "v2: новое своё устройство" 60 && ok "bob1 увидел новое своё устройство" || bad "bob1 не увидел bob2"
  N=$(sqlite3 "$SB/identity.db-v2.db" "SELECT COUNT(DISTINCT device_id) FROM device_state WHERE user='bob@local';")
  [ "$N" = "2" ] && ok "в журнале устройств bob — 2 устройства" || bad "device_state bob: $N (ожидалось 2)"
else
N=$(sqlite3 "$SB/identity.db" "SELECT COUNT(DISTINCT device_id) FROM device_keys WHERE username='bob@local';")
[ "$N" = "2" ] && ok "у bob 2 устройства в identity (device_id разные)" || bad "device_keys bob: $N (ожидалось 2)"
SK=$(sqlite3 "$SB/identity.db" "SELECT COUNT(*) FROM device_keys WHERE username='bob@local' AND signing_key<>'';")
[ "$SK" = "2" ] && ok "оба устройства несут signing_key" || bad "signing_key пуст ($SK/2)"
fi

PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:$T1")
wait_log "$B1/td/log.txt" "входящее msg .* \(alice@local\): $T1" 60 && ok "bob1 получил от alice" || bad "bob1 не получил"
wait_log "$B2/td/log.txt" "входящее msg .* \(alice@local\): $T1" 30 && ok "bob2 получил от alice (fan-out)" || bad "bob2 не получил"
if is_v2; then
  # журнал v2 ведётся на устройство (сервер не хранит «кому от кого»): записи есть у обоих устройств bob
  C=$(sqlite3 "$SB/messenger.db-v2.db" "SELECT COUNT(DISTINCT device) FROM inbox_log;" 2>/dev/null)
  [ "${C:-0}" -ge 2 ] && ok "журналы v2: записи у $C устройств" || bad "записи v2 только у ${C:-0} устройств"
else
C=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM message_device_copies WHERE recipient='bob@local';")
[ "${C:-0}" -ge 2 ] && ok "message_device_copies: $C копий для bob" || bad "копий для bob: ${C:-0}"
fi
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind<>'encrypted' AND kind<>'group_encrypted';")
[ "${K:-0}" = "0" ] && ok "на сервере только шифртекст" || bad "плейнтекст на сервере: $K"
grep -q "ОТКЛОНЕНО" "$B1/td/log.txt" "$B2/td/log.txt" "$A/td/log.txt" && bad "ложная подмена отправителя" || ok "верификация отправителя: без ложных срабатываний"

# bob1 шлёт alice (рестарт в том же workdir — устройство персистно).
stop_pid "$P1"
P1=$(start_client "$B1" bob@local "${PV_DEV_OLD[@]}" PARVANE_AUTOSEND="alice@local:$T2")
wait_log "$A/td/log.txt" "входящее msg .* \(bob@local\): $T2" 60 && ok "alice получила от bob1" || bad "alice не получила bob1"
wait_log "$B2/td/log.txt" "своё msg .* \(alice@local\): $T2" 40 && ok "bob2 видит исходящее bob1 как своё (self-копия)" || bad "bob2 не видит исходящее bob1"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B1/td/log.txt" "$B2/td/log.txt" && bad "фатальная ошибка в логе" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PA"; stack_stop
finish "МУЛЬТИДЕВАЙС"
