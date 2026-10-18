#!/usr/bin/env bash
# Parvane — ключи безопасности (паритет с вебом, KEY-1 v2):
#   1) свой отпечаток корня личности в логе при готовности v2 (12×4 hex, как в вебе);
#   2) в профиле собеседника — отпечаток ЕГО корня: у alice отпечаток bob
#      совпадает с тем, что bob видит у себя (сверка между клиентами);
#   3) bob «переустановился» (новое устройство без прежних) и вошёл в журнал
#      устройств сбросом личности (PARVANE_AUTORESET, пароль аккаунта) → у alice
#      служебное сообщение «ключ безопасности изменился» (RECOVER-1).
# Прежний шаг «лимит частоты gateway» проверял лимит v1-кадров; лимиты канала v2
# проверяют живые тесты parvane-integration.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-seckeys.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; mkdir -p "$A/td" "$B/td"
FP_RE='([0-9a-f]{4} ){11}[0-9a-f]{4}'
# ключ безопасности — отпечаток корня личности из журнала устройств (один на аккаунт, T153)
OWN="свой ключ безопасности v2 \(отпечаток\)"
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "$OWN: $FP_RE" 90 && ok "bob: свой отпечаток в формате веба" || bad "bob: нет своего отпечатка"
BOB_FP=$(grep -oE "$OWN: $FP_RE" "$B/td/log.txt" | head -1 | sed 's/.*: //')
AP=$(start_client "$A" alice@local PARVANE_AUTOSEND="bob@local:keys-$STAMP")
wait_log "$B/td/log.txt" "входящее msg .*alice@local.*keys-$STAMP" 90 && ok "bob получил сообщение alice" || bad "bob не получил сообщение"
wait_log "$A/td/log.txt" "ключ безопасности с bob@local в профиле: $FP_RE" 40 && ok "alice: отпечаток bob в профиле" || bad "alice: нет отпечатка bob в профиле"
A_SEES=$(grep -oE "ключ безопасности с bob@local в профиле: $FP_RE" "$A/td/log.txt" | head -1 | sed 's/.*: //')
[ -n "$BOB_FP" ] && [ "$A_SEES" = "$BOB_FP" ] && ok "отпечаток bob у alice = свой отпечаток bob ($BOB_FP)" || bad "отпечатки расходятся: alice видит «$A_SEES», bob свой «$BOB_FP»"
# bob «переустановился»: состояние устройства v2 и сессия стёрты (JWT привязан к
# device_id — настоящая переустановка начинается со входа). Других устройств у
# аккаунта нет, поэтому сначала сброс личности (новое устройство и новый корень в
# журнале), затем отправка: до привязки устройство v2-аккаунта ничего не шлёт.
stop_pid "$BP"
rm -rf "$B"/td/tdata/parvane-v2-* "$B"/td/tdata/parvane-e2e-* "$B"/td/tdata/parvane-session.txt
BP=$(start_client "$B" bob@local PARVANE_AUTORESET=1)
wait_log "$B/td/log.txt" "v2: autoreset → ok" 60 && ok "bob: личность сброшена, новое устройство в журнале" || bad "bob: сброс личности не прошёл"
wait_log "$B/td/log.txt" "v2: готов" 60 || bad "bob: v2 после сброса не поднялся"
wait_log "$B/td/log.txt" "$OWN: $FP_RE" 30 || bad "bob: после сброса нет своего отпечатка"
NEW_FP=$(grep -oE "$OWN: $FP_RE" "$B/td/log.txt" | head -1 | sed 's/.*: //')
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_AUTOSEND="alice@local:newkey-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*newkey-$STAMP" 60 && ok "alice получила сообщение с нового ключа bob" || bad "alice не получила сообщение с нового ключа"
wait_log "$A/td/log.txt" "ключ безопасности bob@local изменился — служебное сообщение" 20 && ok "alice: служебное сообщение о смене ключа" || bad "alice: нет сообщения о смене ключа"
[ -n "$NEW_FP" ] && [ "$NEW_FP" != "$BOB_FP" ] && ok "у bob действительно новый отпечаток" || bad "отпечаток bob не изменился"
wait_log "$A/td/log.txt" "ключ безопасности с bob@local в профиле: .*$NEW_FP" 20 && ok "alice: в профиле уже новый отпечаток bob" || bad "alice: профиль не обновился на новый отпечаток"
stop_pid "$AP"; stop_pid "$BP"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные ошибки" || ok "без фатальных ошибок"
stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "КЛЮЧИ БЕЗОПАСНОСТИ"
