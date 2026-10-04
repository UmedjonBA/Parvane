#!/usr/bin/env bash
# Parvane — ключи безопасности (паритет с вебом) и лимит частоты gateway:
#   1) свой отпечаток в логе при готовности E2E (формат 12×4 hex, как в вебе);
#   2) в профиле собеседника — отпечатки ЕГО устройств: у alice отпечаток bob
#      совпадает с тем, что bob видит у себя (сверка между клиентами);
#   3) bob переустановил E2E (новый identity) → у alice служебное сообщение
#      «ключ безопасности изменился»;
#   4) gateway с жёстким лимитом → в логе клиента rate_limited (тост в UI).
# Протокол v2 (по умолчанию, T135): «переустановка» bob — новое устройство без
# прежних; в журнал устройств оно входит сбросом личности (PARVANE_AUTORESET,
# пароль аккаунта) — у alice то же служебное сообщение о смене ключа (KEY-1 v2,
# RECOVER-1). PV_PROTO=v1 — прежний путь.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-seckeys.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; mkdir -p "$A/td" "$B/td"
FP_RE='([0-9a-f]{4} ){11}[0-9a-f]{4}'
# v2: ключ безопасности — отпечаток корня личности из журнала устройств (один на
# аккаунт, T153); v1 — отпечаток identity-ключа устройства
if is_v2; then OWN="свой ключ безопасности v2 \(отпечаток\)"; else OWN="свой ключ безопасности \(отпечаток\)"; fi
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "$OWN: $FP_RE" 40 && ok "bob: свой отпечаток в формате веба" || bad "bob: нет своего отпечатка"
BOB_FP=$(grep -oE "$OWN: $FP_RE" "$B/td/log.txt" | head -1 | sed 's/.*: //')
AP=$(start_client "$A" alice@local PARVANE_AUTOSEND="bob@local:keys-$STAMP")
wait_log "$B/td/log.txt" "входящее msg .*alice@local.*keys-$STAMP" 40 && ok "bob получил сообщение alice" || bad "bob не получил сообщение"
wait_log "$A/td/log.txt" "ключ безопасности с bob@local в профиле: $FP_RE" 40 && ok "alice: отпечаток bob в профиле" || bad "alice: нет отпечатка bob в профиле"
A_SEES=$(grep -oE "ключ безопасности с bob@local в профиле: $FP_RE" "$A/td/log.txt" | head -1 | sed 's/.*: //')
[ -n "$BOB_FP" ] && [ "$A_SEES" = "$BOB_FP" ] && ok "отпечаток bob у alice = свой отпечаток bob ($BOB_FP)" || bad "отпечатки расходятся: alice видит «$A_SEES», bob свой «$BOB_FP»"
# bob «переустановился»: новый identity-ключ (персист E2E стёрт) → у alice
# смена ключа известного контакта → служебное сообщение. Сессию стираем тоже:
# JWT привязан к device_id (claim dev), и identity не примет prekeys нового
# устройства по токену старого — настоящая переустановка начинается со входа.
stop_pid "$BP"
rm -rf "$B"/td/tdata/parvane-e2e-* "$B"/td/tdata/parvane-session.txt
if is_v2; then
  # сначала сброс личности (новое устройство входит в журнал), затем отправка:
  # до привязки устройство v2-аккаунта ничего не шлёт
  BP=$(start_client "$B" bob@local PARVANE_AUTORESET=1)
  wait_log "$B/td/log.txt" "v2: autoreset → ok" 60 && ok "bob: личность сброшена, новое устройство в журнале" || bad "bob: сброс личности не прошёл"
  wait_log "$B/td/log.txt" "v2: готов" 60 || bad "bob: v2 после сброса не поднялся"
  wait_log "$B/td/log.txt" "$OWN: $FP_RE" 30 || bad "bob: после сброса нет своего отпечатка"
  NEW_FP=$(grep -oE "$OWN: $FP_RE" "$B/td/log.txt" | head -1 | sed 's/.*: //')
  stop_pid "$BP"
fi
BP=$(start_client "$B" bob@local PARVANE_AUTOSEND="alice@local:newkey-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*newkey-$STAMP" 60 && ok "alice получила сообщение с нового ключа bob" || bad "alice не получила сообщение с нового ключа"
wait_log "$A/td/log.txt" "ключ безопасности bob@local изменился — служебное сообщение" 20 && ok "alice: служебное сообщение о смене ключа" || bad "alice: нет сообщения о смене ключа"
is_v2 || NEW_FP=$(grep -oE "$OWN: $FP_RE" "$B/td/log.txt" | head -1 | sed 's/.*: //')
[ -n "$NEW_FP" ] && [ "$NEW_FP" != "$BOB_FP" ] && ok "у bob действительно новый отпечаток" || bad "отпечаток bob не изменился"
wait_log "$A/td/log.txt" "ключ безопасности с bob@local в профиле: .*$NEW_FP" 20 && ok "alice: в профиле уже новый отпечаток bob" || bad "alice: профиль не обновился на новый отпечаток"
stop_pid "$AP"; stop_pid "$BP"
# лимит частоты: gateway без бюджета на сообщения (всплеск 0) — первая же
# отправка autosend упирается в rate_limited. Это лимит v1-кадров gateway:
# сообщение v2-собеседнику идёт двоичным каналом v2 со своими классами лимитов
# (их проверяют живые тесты parvane-integration), поэтому шаг — на v1-клиенте.
# На сервере без v1 (PV_V1_OFF) шаг пропускается: v1-клиента там нет.
if v1_off; then
  ok "без v1: лимит v1-кадров не проверяется (лимиты v2 — живые тесты parvane-integration)"
else
  PV_GATEWAY_ENV="GATEWAY_RATE_MSG_BURST=0 GATEWAY_RATE_MSG_PER_SEC=0.01" gateway_restart
  AP=$(start_client "$A" alice@local PARVANE_PROTO_V2=0 PARVANE_AUTOSEND="bob@local:flood-$STAMP")
  wait_log "$A/td/log.txt" "gateway rate_limited" 60 && ok "alice: rate_limited от gateway замечен (тост)" || bad "alice: rate_limited не замечен"
fi
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные ошибки" || ok "без фатальных ошибок"
stop_pid "$AP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "КЛЮЧИ БЕЗОПАСНОСТИ + RATE LIMIT"
