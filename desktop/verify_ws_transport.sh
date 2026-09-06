#!/usr/bin/env bash
# Parvane — транспорт WebSocket (как у веба и прода): клиент ходит в gateway по
# ws://…/ws (PARVANE_GATEWAY_URL=ws://127.0.0.1:9222/ws), второй — по TCP.
# Проверяем: логин/устройство через WS, обмен сообщениями WS ↔ TCP в обе стороны.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-ws.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"
mkdir -p "$A/td" "$B/td"
# bob (TCP) публикует устройство первым
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob: устройство не готово"
# alice — по WebSocket
env QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='ws://127.0.0.1:9222/ws' \
  PARVANE_AUTOLOGIN="alice@local:test" PARVANE_AUTOSEND="bob@local:ws-hello-$STAMP" \
  "$BIN" -workdir "$A/td" >>"$A/stdout.log" 2>&1 & AP=$!
wait_log "$A/td/log.txt" "E2E-устройство готово" 40 && ok "alice: логин и устройство через WebSocket" || bad "alice: нет устройства через WS"
grep -q "транспорт gateway WebSocket ws://127.0.0.1:9222/ws" "$A/td/log.txt" && ok "alice: транспорт WebSocket в логе" || bad "alice: в логе нет WebSocket-транспорта"
wait_log "$B/td/log.txt" "входящее msg .*alice@local.*ws-hello-$STAMP" 40 && ok "bob (TCP) получил сообщение от alice (WS)" || bad "bob не получил сообщение alice"
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_AUTOSEND="alice@local:tcp-reply-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*tcp-reply-$STAMP" 40 && ok "alice (WS) получила ответ bob (TCP)" || bad "alice не получила ответ bob"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные ошибки в логах" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "WS ТРАНСПОРТ"
