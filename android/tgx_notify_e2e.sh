#!/usr/bin/env bash
# Уведомления кросс-девайс в форке X (spec 031, STATE-2 вид notify): alice-десктоп мутит bob (PARVANE_AUTOMUTE) →
# запись журнала личного состояния → X (второе устройство alice) применяет её: «журнал состояния → уведомления
# (N чатов …)» и UpdateChatNotificationSettings — чат bob замучен в списке.
# После tgx_protocol_link_flow.sh (стек в последнем /tmp/pv-tgx.*, X — второе устройство alice).
#   ./tgx_notify_e2e.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-notify}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); A="$SB/alice"; AL="$A/td/log.txt"

tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята (второе устройство alice)" || bad "X: сессии нет"
tgx_logwait "журнал личного состояния подключён" 60 || bad "X: журнал личного состояния не подключён"
sleep 3; tgx_shot "$OUT/01-before.png"
tgx_mark
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOMUTE="bob@local:15")
wait_log "$AL" "automute → bob@local" 90 && ok "alice-десктоп замутила bob" || bad "automute не сработал"
tgx_logwait "журнал состояния → уведомления \([1-9][0-9]* чатов" 90 && ok "X: мут применён из журнала личного состояния" \
  || bad "X: мут из журнала не пришёл"
tgx_mark
tgx_put parvane-e2e-cmd '{"op":"notify","peer":"bob@local"}'
tgx_logwait "уведомления bob@local: muteFor=[1-9]" 30 && ok "X: чат bob показан замученным" || bad "X: чат bob не замучен в UI"
# после перезапуска — тот же мут (чат создаётся с настройками из журнала, а не по умолчанию)
tgx_stop; tgx_start
tgx_logwait "журнал личного состояния подключён" 90 || bad "X: журнал после перезапуска не подключён"
sleep 3
tgx_mark
tgx_put parvane-e2e-cmd '{"op":"notify","peer":"bob@local"}'
tgx_logwait "уведомления bob@local: muteFor=[1-9]" 30 && ok "X: мут пережил перезапуск" || bad "X: мут потерян после перезапуска"
sleep 3; tgx_shot "$OUT/02-after-mute.png"
stop_pid "$AP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX NOTIFY"
