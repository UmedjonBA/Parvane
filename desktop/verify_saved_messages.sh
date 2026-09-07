#!/usr/bin/env bash
# Parvane — «Избранное» между двумя устройствами ОДНОГО пользователя.
# Устройство B (тот же ник) публикует ключи; устройство A шлёт САМО СЕБЕ;
# проверяем, что B получил это в «Избранном» (self-диалог).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-saved.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/devA"; B="$SB/devB"; mkdir -p "$A/td" "$B/td"
# B входит первым (публикует устройство), без автосенда
BP=$(start_client "$B" alice@local)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "B: устройство не готово"
# A входит и шлёт САМ СЕБЕ (alice@local → alice@local)
AP=$(start_client "$A" alice@local PARVANE_AUTOSEND="alice@local:saved-$STAMP")
wait_log "$A/td/log.txt" "отправлено msg .*alice@local" 40 && ok "A отправил в Избранное" || bad "A не отправил себе"
# B должен получить копию (сообщение самому себе) в self-диалог
wait_log "$B/td/log.txt" "saved-$STAMP" 40 && ok "B получил Избранное с устройства A" || bad "B НЕ получил Избранное (кросс-девайс не работает)"
echo "--- A log (self) ---"; grep -iE "saved-$STAMP|Избранн|своё msg|отправлено msg" "$A/td/log.txt" 2>/dev/null | head
echo "--- B log ---"; grep -iE "saved-$STAMP|входящее|своё msg|инъецировано" "$B/td/log.txt" 2>/dev/null | head
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные" || ok "без фатальных"
stop_pid "$AP"; stop_pid "$BP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ИЗБРАННОЕ КРОСС-ДЕВАЙС"
