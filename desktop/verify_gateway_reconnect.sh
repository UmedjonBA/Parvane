#!/usr/bin/env bash
# Parvane — обрыв соединения с gateway (рестарт caddy при деплое, сеть):
#   1) alice и bob переписываются через локальный gateway;
#   2) gateway перезапускается — оба клиента теряют WS/TCP;
#   3) bob пишет — его транспорт переподключается на publish; alice получает
#      сообщение — её транспорт переподключился на sync и переподписался на
#      инбокс. 10 сен 2026: раньше транспорт навсегда оставался «не подключено».
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="${SCRATCH:-$(mktemp -d /tmp/pv-reconn.XXXXXX)}"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; mkdir -p "$A/td" "$B/td"

AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$A/td/log.txt" "E2E-устройство готово" 40 && ok "alice готова" || bad "alice не готова"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:before-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*before-$STAMP" 60 && ok "до обрыва: alice получила" || bad "до обрыва: alice не получила"

gateway_restart
# «не подключено» в логе не ждём: переподключение на следующем sync (3 с)
# обычно успевает раньше, чем клиент запишет ошибку
wait_log "$A/td/log.txt" "gateway переподключён" 30 && ok "alice переподключилась" || bad "alice не переподключилась"
wait_log "$B/td/log.txt" "gateway переподключён" 30 && ok "bob переподключился" || bad "bob не переподключился"

# Живой обмен после обрыва (второй autosend через хук нельзя — шлём с alice)
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:after-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*after-$STAMP" 60 && ok "после обрыва: alice получила" || bad "после обрыва: alice не получила"
grep -aqE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные ошибки" || ok "без фатальных ошибок"

stop_pid "$AP"; stop_pid "$BP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ПЕРЕПОДКЛЮЧЕНИЕ К GATEWAY"
