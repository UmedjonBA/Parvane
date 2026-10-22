#!/usr/bin/env bash
# Федерация на X (spec 031, FED-1): два локальных сервера, как desktop/verify_federation.sh, — X (alice@a) на сервере A,
# bob@b (desktop) на сервере B. Свои стеки: запускать отдельно от остальных сценариев (в конце волны).
#   1. alice@a (X) пишет bob@b — письмо дошло через федерацию; bob отвечает — X получил;
#   2. шард federation сервера B остановлен → X запрашивает профиль нового адреса carol@b → отказ «другой сервер
#      недоступен» показан понятным текстом (событие federation_error), без падения.
#   ./tgx_federation_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-federation}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"

A_DOMAIN="a.parvane.test"; B_DOMAIN="b.parvane.test"
A_FED="${PV_A_FED_PORT:-9330}"; B_FED="${PV_B_FED_PORT:-9331}"
A_USER="alice@$A_DOMAIN"; B_USER="bob@$B_DOMAIN"
S=$(date +%s); A_TEXT="fed-x-$S"; B_TEXT="fed-bob-$S"
server_a() {
  PV_DOMAIN="$A_DOMAIN"; PV_NATS_PORT=4222; PV_GW_WS_PORT=9222; PV_GW_TCP_PORT=9223
  PV_FEDERATION_PORT="$A_FED"; PV_FEDERATION_PEERS="$B_DOMAIN=http://127.0.0.1:$B_FED"
}
server_b() {
  PV_DOMAIN="$B_DOMAIN"; PV_NATS_PORT=4322; PV_GW_WS_PORT=9322; PV_GW_TCP_PORT=9323
  PV_FEDERATION_PORT="$B_FED"; PV_FEDERATION_PEERS="$A_DOMAIN=http://127.0.0.1:$A_FED"
}
RUN="$(mktemp -d /tmp/pv-tgx-fed.XXXXXX)"; B="$RUN/bob"; BL="$B/td/log.txt"
server_a; stack_up "$RUN/stack-a"; SB_A="$SB"
server_b; stack_up "$RUN/stack-b"; SB_B="$SB"
grep -qa "Federation шард запущен" "$SB_A/federation.log" && grep -qa "Federation шард запущен" "$SB_B/federation.log" \
  && ok "шарды federation обоих серверов подняты" || bad "шард federation не поднялся"

# 1. переписка через федерацию: bob заводит устройство, X пишет, bob отвечает
server_b; BP=$(start_client "$B" "$B_USER" PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob поднялся на сервере B" || bad "bob: v2 не поднялся на сервере B"
server_a
emu_boot "$OUT" || { bad "эмулятор не загрузился"; finish "TGX FEDERATION"; }
tgx_install
tgx_fresh "$A_USER"
tgx_logwait "v2: готов" 90 && ok "X (alice) поднялась на сервере A" || bad "X: v2 не поднялся на сервере A"
tgx_cmd "{\"op\":\"send\",\"peer\":\"$B_USER\",\"text\":\"$A_TEXT\"}" || bad "X: команда отправки не выполнена"
wait_log "$BL" "Parvane: входящее msg .* \($A_USER\): $A_TEXT" 120 && ok "FED-1: bob@B получил письмо X через федерацию" || bad "FED-1: bob@B не получил письмо X"
stop_pid "$BP"
mv "$BL" "$B/td/log.first.txt" 2>/dev/null
tgx_mark
server_b; BP=$(start_client "$B" "$B_USER" PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=$A_USER:$B_TEXT")
server_a
tgx_logwait "сообщение [0-9a-f-]{36} → чат [0-9]+ \(вх\)" 120 && ok "FED-1: X получил ответ bob@B" || bad "FED-1: X не получил ответ bob@B"
grep -aqE "федерация: отказ" "$TGX_LOG" && bad "FED-1: отказ федерации при живых серверах" || ok "FED-1: отказов федерации нет"
stop_pid "$BP"

# 2. сервер B недоступен для федерации → понятный отказ
FP=$(ss -ltnpH "sport = :$B_FED" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$FP" ] && kill "$FP" 2>/dev/null && ok "федерация сервера B остановлена" || bad "шард federation B не найден"
tgx_mark
tgx_put parvane-e2e-cmd "{\"op\":\"resolve\",\"peer\":\"carol@$B_DOMAIN\"}"
tgx_logwait "федерация: отказ (unreachable|refused)" 120 && ok "FED-1 (X): недоступный сервер — понятный отказ" || bad "FED-1 (X): отказ федерации не распознан"
sleep 3; tgx_shot "$OUT/01-federation.png"
tgx_no_crash
grep -qaE 'Permissions Violation' "$SB_A/nats.log" 2>/dev/null && bad "NATS ACL сервера A: нарушение прав роли"
kill "$TGX_LCP" 2>/dev/null
clients_kill "$RUN"
stack_stop
finish "TGX FEDERATION (FED-1)"
