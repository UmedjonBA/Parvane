#!/usr/bin/env bash
# Parvane — отказ авторизации (просроченный/битый JWT) и «сессия без адреса».
#   1) alice регистрируется, устройство готово, клиент закрыт;
#   2) JWT в tdata/parvane-session.txt портим → на старте gateway отвергает
#      токен: «авторизация отклонена», клиент НЕ падает (10 сен 2026:
#      forcedLogOut пересоздавал MTP-инстанс до разрушения сессии и ронял
#      процесс в ~MTP::Sender), уходит на экран входа (хук автологина входит
#      заново) и сессия поднимается с адресом;
#   3) «зомби»: удаляем ТОЛЬКО parvane-session.txt (так выглядит диск после
#      падения до local().reset(): userId в mtp-данных есть, адреса нет) →
#      клиент сам уводит на экран входа вместо пустого окна без чатов и без
#      кнопки выхода; повторный вход возвращает устройство и историю.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="${SCRATCH:-$(mktemp -d /tmp/pv-authrej.XXXXXX)}"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; mkdir -p "$A/td" "$B/td"
CREDS="$A/td/tdata/parvane-session.txt"

# 1) регистрация alice; bob пишет ей — появляется журнал истории
P=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$A/td/log.txt" "E2E-устройство готово" 40 && ok "alice: устройство готово" || bad "alice: устройство не готово"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:hi-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*hi-$STAMP" 60 && ok "alice получила сообщение bob (журнал есть)" || bad "alice не получила сообщение bob"
sleep 2; stop_pid "$BP"; stop_pid "$P"
[ -s "$CREDS" ] && ok "учётные данные на диске" || bad "нет $CREDS"

# 2) битый JWT → отказ авторизации без падения, экран входа, повторный вход
ADDR=$(head -1 "$CREDS"); printf '%s\nexpired.jwt.token\n' "$ADDR" > "$CREDS"
P=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$A/td/log.txt" "логин-состояние восстановлено с диска" 40 || bad "сессия не восстановилась с диска"
wait_log "$A/td/log.txt" "авторизация отклонена .*на экран входа" 40 && ok "отказ JWT распознан" || bad "отказ JWT не распознан"
wait_log "$A/td/log.txt" "выход — учётные данные удалены" 20 && ok "учётные данные сняты" || bad "учётные данные не сняты"
wait_log "$A/td/log.txt" "autologin hook for alice@local" 40 && ok "показан экран входа (хук автологина сработал)" || bad "экран входа не показан"
wait_log "$A/td/log.txt" "сессия поднята для alice@local" 40 && ok "повторный вход: сессия с адресом" || bad "повторный вход не удался"
kill -0 "$P" 2>/dev/null && ok "клиент жив после отказа JWT" || bad "клиент упал после отказа JWT"
wait_log "$A/td/log.txt" "воспроизведено [1-9][0-9]* сообщений из журнала" 20 && ok "история сохранена" || bad "история потеряна"
wait_log "$A/td/log.txt" "вход — первый sync полный" 20 && ok "после входа первый sync полный" || bad "после входа sync не полный"
wait_log "$A/td/log.txt" "профиль alice@local: bio=" 30 && ok "свой профиль резолвится после входа" || bad "свой профиль не резолвится после входа"
sleep 2; stop_pid "$P"

# 3) «зомби»: mtp-данные с userId есть, учётных данных Parvane нет
rm -f "$CREDS"
P=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$A/td/log.txt" "сессия без адреса — учётных данных нет, на экран входа" 40 \
  && ok "сессия без адреса → экран входа" || bad "сессия без адреса не распознана"
grep -aqE "сессия поднята для $" "$A/td/log.txt" && bad "поднята сессия с ПУСТЫМ адресом" || ok "сессии с пустым адресом нет"
wait_log "$A/td/log.txt" "autologin hook for alice@local" 40 && ok "показан экран входа" || bad "экран входа не показан"
wait_log "$A/td/log.txt" "сессия поднята для alice@local" 40 && ok "повторный вход после «зомби»" || bad "повторный вход после «зомби» не удался"
kill -0 "$P" 2>/dev/null && ok "клиент жив" || bad "клиент упал"
sleep 2; stop_pid "$P"

grep -aqiE "Fatal|Unexpected in " "$A/td/"log*.txt && bad "фатальные ошибки" || ok "без фатальных ошибок"
stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ОТКАЗ АВТОРИЗАЦИИ / СЕССИЯ БЕЗ АДРЕСА"
