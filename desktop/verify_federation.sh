#!/usr/bin/env bash
# Parvane — федерация (spec 028, правило conformance FED-1) на desktop: два локальных
# сервера и два РЕАЛЬНЫХ экземпляра форка, по одному на сервер.
#   сервер A — домен a.parvane.test, NATS 4222, gateway 9222/9223, вход федерации 9330;
#   сервер B — домен b.parvane.test, NATS 4322, gateway 9322/9323, вход федерации 9331.
# Связь серверов — тестовый транспорт шарда federation (HTTP к loopback; бинарь собран
# `cargo build -p federation --features insecure-test-transport`), как у
# `scripts/run_web_federation_e2e.sh` и `parvane-integration --test v2_federation_live`.
# alice@a ходит только в gateway A, bob@b — только в gateway B; запросы к объекту чужого
# сервера клиент шлёт своему серверу с `Request.dest_domain` (FED-1 п. 1), жетоны для
# письма незнакомцу — от сервера адресата (п. 3).
# Проверяем:
#   1) оба поднялись на своих серверах (журнал устройств v2);
#   2) alice → bob@b: письмо дошло через федерацию;
#   3) bob → alice@a: ответ дошёл;
#   4) у обоих диалог с собеседником в списке;
#   5) отказов федерации (FEDERATION_UNAVAILABLE, DOMAIN_*, SERVER_KEY_CHANGED) в логах нет;
#   6) ACL NATS обоих стеков не нарушен, фатальных ошибок нет.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"

A_DOMAIN="a.parvane.test"
B_DOMAIN="b.parvane.test"
A_FED="${PV_A_FED_PORT:-9330}"
B_FED="${PV_B_FED_PORT:-9331}"
A_USER="alice@$A_DOMAIN"
B_USER="bob@$B_DOMAIN"
STAMP="$(date +%s)"
A_TEXT="fed-from-alice-$STAMP"
B_TEXT="fed-from-bob-$STAMP"

# Окружение стеков: функции verify_lib.sh читают домен, порты и вход федерации в момент вызова
server_a() {
  PV_DOMAIN="$A_DOMAIN"; PV_NATS_PORT=4222; PV_GW_WS_PORT=9222; PV_GW_TCP_PORT=9223
  PV_FEDERATION_PORT="$A_FED"; PV_FEDERATION_PEERS="$B_DOMAIN=http://127.0.0.1:$B_FED"
}
server_b() {
  PV_DOMAIN="$B_DOMAIN"; PV_NATS_PORT=4322; PV_GW_WS_PORT=9322; PV_GW_TCP_PORT=9323
  PV_FEDERATION_PORT="$B_FED"; PV_FEDERATION_PEERS="$A_DOMAIN=http://127.0.0.1:$A_FED"
}

# Профили — только в local-workdirs (корневой CLAUDE.md)
WORK_ROOT="$ROOT/../local-workdirs/verify-federation"
mkdir -p "$WORK_ROOT"
RUN="$(mktemp -d "$WORK_ROOT/run.XXXXXX")"
A_WORK="$RUN/alice"
B_WORK="$RUN/bob"
A_LOG="$A_WORK/td/log.txt"
B_LOG="$B_WORK/td/log.txt"
echo "каталог прогона: $RUN"

server_a; stack_up "$RUN/stack-a"; SB_A="$SB"
server_b; stack_up "$RUN/stack-b"; SB_B="$SB"
grep -qa "Federation шард запущен" "$SB_A/federation.log" && grep -qa "Federation шард запущен" "$SB_B/federation.log" \
  && ok "шарды federation обоих серверов подняты" || bad "шард federation не поднялся"

# Свежий workdir = новое устройство v2: получатель заводит журнал устройств ДО письма в
# его сторону. bob (B) поднимается первым, alice (A) пишет ему, затем bob перезапускается
# в том же workdir и отвечает (как pair_exchange, но клиенты на разных серверах).
server_b; PB=$(start_client "$B_WORK" "$B_USER" PARVANE_NO_LINK_OFFER=1)
wait_log "$B_LOG" "v2: готов" 90 && ok "bob поднялся на сервере B" || bad "bob: v2 не поднялся на сервере B"
server_a; PA=$(start_client "$A_WORK" "$A_USER" PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=$B_USER:$A_TEXT")
wait_log "$A_LOG" "v2: готов" 90 && ok "alice поднялась на сервере A" || bad "alice: v2 не поднялся на сервере A"
wait_log "$B_LOG" "Parvane: входящее msg .* \($A_USER\): $A_TEXT" 120 \
  && ok "bob@B получил письмо alice@A через федерацию" || bad "bob@B не получил письмо alice@A"
stop_pid "$PB"
mv "$B_LOG" "$B_WORK/td/log.first.txt" 2>/dev/null
server_b; PB=$(start_client "$B_WORK" "$B_USER" PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=$A_USER:$B_TEXT")
wait_log "$A_LOG" "Parvane: входящее msg .* \($B_USER\): $B_TEXT" 120 \
  && ok "alice@A получила ответ bob@B через федерацию" || bad "alice@A не получила ответ bob@B"
sleep 2
stop_pid "$PA"; stop_pid "$PB"
# Обе фазы bob — в один файл для проверок ниже
cat "$B_WORK/td/log.first.txt" >> "$B_LOG" 2>/dev/null || true

grep -qa "Parvane: autosend → $B_USER: $A_TEXT" "$A_LOG" && ok "alice отправила bob@B" || bad "alice не отправила"
grep -qa "Parvane: autosend → $A_USER: $B_TEXT" "$B_LOG" && ok "bob отправил alice@A" || bad "bob не отправил"
grep -qa "Parvane: диалог $B_USER — в списке=1" "$A_LOG" && ok "у alice диалог bob@B в списке" || bad "у alice нет диалога с bob@B"
grep -qa "Parvane: диалог $A_USER — в списке=1" "$B_LOG" && ok "у bob диалог alice@A в списке" || bad "у bob нет диалога с alice@A"
if grep -qaE "FEDERATION_UNAVAILABLE|DOMAIN_BLOCKED|DOMAIN_REFUSED|DOMAIN_UNREACHABLE|SERVER_KEY_CHANGED" "$A_LOG" "$B_LOG"; then
  bad "в логах клиентов — отказ федерации"
  grep -haE "FEDERATION_UNAVAILABLE|DOMAIN_|SERVER_KEY_CHANGED" "$A_LOG" "$B_LOG" | head -5
else
  ok "отказов федерации в логах клиентов нет"
fi
grep -qiE "Fatal|Unexpected in " "$A_LOG" "$B_LOG" && bad "фатальная ошибка в логе клиента" || ok "без фатальных ошибок"
# finish проверяет ACL только последнего стека ($SB = B) — стек A сверяем здесь
grep -qaE 'Permissions Violation' "$SB_A/nats.log" 2>/dev/null && bad "NATS ACL сервера A: нарушение прав роли (см. $SB_A/nats.log)"

clients_kill "$RUN"
stack_stop
[ "$RC" -eq 0 ] && rm -rf "$RUN" || echo "логи: $RUN (клиенты — */td/log.txt, серверы — stack-a/, stack-b/)"
finish "ФЕДЕРАЦИЯ (FED-1)"
