#!/usr/bin/env bash
# Parvane — звонок на пользователя, который вошёл со ВТОРОГО устройства.
# identity хранит один pubkey (ключ звонков) на пользователя и заменяет его
# только с паролем (P-07), поэтому ключ звонков устройства d2 в identity не
# попадает — там остаётся ключ d1. Устройство d2 подписывает сигналы звонка
# signing-ключом устройства из каталога prekeys, а звонящий перед invite
# перечитывает каталог устройств собеседника (e2e::refreshContact) и проверяет
# подпись по ключам ВСЕХ его устройств (e2e::contactSigningKeys). Сценарий:
#   1) bob входит с устройства d1 (публикует prekeys и ключ звонков);
#   2) bob входит с устройства d2 (новый workdir → новые ключи; identity ключ
#      звонков d2 не принимает);
#   3) alice звонит bob; bob (d2) авто-принимает; оба доходят до Active —
#      подпись answer прошла по ключу устройства d2 из каталога.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-callmd.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B1="$SB/bob1"; B2="$SB/bob2"; mkdir -p "$A/td" "$B1/td" "$B2/td"
# 1) bob публикует устройство d1 (prekeys в каталоге identity)
B1P=$(start_client "$B1" bob@local)
wait_log "$B1/td/log.txt" "E2E-устройство готово" 40 && ok "bob опубликовал устройство d1" || bad "bob d1 не готов"
stop_pid "$B1P"
# 2) bob входит со ВТОРОГО устройства d2 (новый workdir = новые ключи).
# В identity остаётся ключ звонков d1 (замена — только с паролем); каталог
# prekeys хранит ОБА устройства (d1+d2) — alice при звонке узнаёт оба ключа.
B2P=$(start_client "$B2" bob@local PARVANE_AUTOACCEPT=1)
wait_log "$B2/td/log.txt" "E2E-устройство готово" 40 && ok "bob вошёл с устройства d2 (новый ключ)" || bad "bob d2 не готов"
wait_log "$B2/td/log.txt" "ключ звонков не принят identity" 20 && ok "d2: identity не заменил ключ звонков без пароля → подпись ключом устройства" || bad "d2: нет перехода на подпись ключом устройства"
# 3) alice звонит bob (теперь активно d2); проверяем аутентификацию подписи
AP=$(start_client "$A" alice@local PARVANE_AUTOCALL="bob@local")
wait_log "$B2/td/log.txt" "ВХОДЯЩИЙ звонок от alice@local" 50 && ok "bob d2: входящий звонок от alice" || bad "bob d2 не получил входящий"
# Ключевая проверка: сигналинг прошёл аутентификацию и звонок стал активным.
# Если бы подпись d2 не нашлась среди ключей контакта, до Active не дошли бы.
for _ in $(seq 1 50); do
  grep -qa "звонок → Active" "$A/td/log.txt" 2>/dev/null && grep -qa "звонок → Active" "$B2/td/log.txt" 2>/dev/null && break
  sleep 1
done
grep -qa "звонок → Active" "$A/td/log.txt" && ok "alice → Active" || bad "alice не дошла до Active"
grep -qa "звонок → Active" "$B2/td/log.txt" && ok "bob d2 → Active (подпись принята по ключу устройства d2)" || bad "bob d2 не дошёл до Active (подпись d2 не принята?)"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B2/td/log.txt" && bad "фатальные ошибки" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$B2P"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ЗВОНОК МУЛЬТИДЕВАЙС"
