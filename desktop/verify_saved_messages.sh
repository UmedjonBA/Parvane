#!/usr/bin/env bash
# Parvane — «Избранное» между двумя устройствами ОДНОГО пользователя.
# Устройство B заводит аккаунт; A — второе устройство, сначала привязывается
# грантом линковки (LINK-1 v2), затем шлёт САМО СЕБЕ; «Избранное» идёт по v2
# копиями своим устройствам журнала — проверяем, что B получил это в self-диалог.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-saved.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/devA"; B="$SB/devB"; mkdir -p "$A/td" "$B/td"
# B входит первым (публикует устройство), без автосенда
BP=$(start_client "$B" alice@local "${PV_DEV_OLD[@]}")
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "B: устройство не готово"
AP=$(start_client "$A" alice@local "${PV_DEV_NEW[@]}")
wait_linked "$A/td/log.txt" && ok "A привязан грантом линковки" || bad "A не привязан"
stop_pid "$AP"
# A входит и шлёт САМ СЕБЕ (alice@local → alice@local)
AP=$(start_client "$A" alice@local "${PV_DEV_NEW[@]}" PARVANE_AUTOSEND="alice@local:saved-$STAMP")
wait_log "$A/td/log.txt" "v2 → alice@local msg|отправлено msg .*alice@local" 60 && ok "A отправил в Избранное" || bad "A не отправил себе"
# B должен получить копию (сообщение самому себе) в self-диалог
wait_log "$B/td/log.txt" "saved-$STAMP" 60 && ok "B получил Избранное с устройства A" || bad "B НЕ получил Избранное (кросс-девайс не работает)"
echo "--- A log (self) ---"; grep -iE "saved-$STAMP|Избранн|своё msg|отправлено msg" "$A/td/log.txt" 2>/dev/null | head
echo "--- B log ---"; grep -iE "saved-$STAMP|входящее|своё msg|инъецировано" "$B/td/log.txt" 2>/dev/null | head
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные" || ok "без фатальных"
stop_pid "$AP"; stop_pid "$BP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ИЗБРАННОЕ КРОСС-ДЕВАЙС"
