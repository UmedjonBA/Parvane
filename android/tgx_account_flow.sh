#!/usr/bin/env bash
# Аккаунт и группы на X (spec 031): REPORT-1, PUBLIC-1, RENAME-1, DELETE-1 через шов X — те же вызовы, что окна X и
# экран «Аккаунт и устройства» оверлея. После tgx_session_flow.sh (стек в последнем /tmp/pv-tgx.*, X — alice, bob — desktop).
#   1. REPORT-1: bob пишет alice → X жалуется на чат (спам, последнее входящее) → жалоба администратору сервера принята;
#   2. PUBLIC-1: X создаёт группу с bob, делает её публичной с именем → имя занято для повторной проверки;
#   3. RENAME-1: X меняет ник → bob пишет на прежний адрес: «сменил ник» в прежнем чате, письмо пришло X; на новый — тоже;
#   4. DELETE-1: X удаляет аккаунт; вход с ответом «Не входить» — вопрос с датой, вход отменён; вход с «Восстановить» —
#      удаление отменено, вход идёт (новое устройство просит привязку); bob видит аккаунт снова доступным.
#   ./tgx_account_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-account}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); B="$SB/bob"; BL="$B/td/log.txt"
S=$(date +%s); G="pvacct-$S"; PUB="pvpub$S"; NICK="alicer$S"
# успех команды — ответ шва без Error (Ok, CreatedBasicGroupChat, …)
cmd_ok() { tgx_mark; tgx_put parvane-e2e-cmd "$1"; tgx_logwait "e2e-cmd $(printf '%s' "$1" | python3 -c 'import sys,json; print(json.load(sys.stdin)["op"])') → [A-Z][A-Za-z]*" "${2:-60}" && ! tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aq "e2e-cmd .* → Error"; }
a shell rm -f /data/local/tmp/parvane-e2e-cmd /data/local/tmp/parvane-deletion-answer

tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"

# 1. REPORT-1
tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:spam-$S")
tgx_logwait "сообщение [0-9a-f-]{36} → чат [0-9]+ \(вх\)" 90 && ok "X получил сообщение bob" || bad "X не получил сообщение bob"
tgx_mark
tgx_put parvane-e2e-cmd '{"op":"report","peer":"bob@local","reason":"spam","comment":"vydumannyj kommentarij"}'
tgx_logwait "жалоба \(spam\) → sent" 60 && ok "REPORT-1 (X): жалоба администратору сервера принята" || bad "REPORT-1 (X): жалоба не принята"

# 2. PUBLIC-1
tgx_mark
cmd_ok "{\"op\":\"group_create\",\"peer\":\"bob@local\",\"title\":\"$G\",\"members\":[\"bob@local\"]}" && ok "X создал группу $G" || bad "X: группа не создана"
tgx_logwait "группа v2 v2g:[0-9a-f]+ появилась" 60 || bad "X: группа не появилась в журнале"
cmd_ok "{\"op\":\"public_set\",\"peer\":\"bob@local\",\"group\":\"$G\",\"name\":\"$PUB\"}" 90 && ok "PUBLIC-1 (X): группа публичная ($PUB)" || bad "PUBLIC-1 (X): публичность не применена"
tgx_logwait "публичность группы v2g:[0-9a-f]+: публичная → ok" 5 || bad "PUBLIC-1 (X): нет маркера публичности"
tgx_mark
tgx_put parvane-e2e-cmd "{\"op\":\"public_check\",\"peer\":\"bob@local\",\"name\":\"$PUB\"}"
tgx_logwait "имя $PUB: " 30 && ! tail -n "+$TGX_MARK" "$TGX_LOG" | grep -a "имя $PUB: " | grep -q '"available":true' \
  && ok "PUBLIC-1 (X): имя занято для других" || bad "PUBLIC-1 (X): имя не заняло место в общем пространстве"

# 3. RENAME-1
tgx_mark
cmd_ok "{\"op\":\"rename\",\"peer\":\"bob@local\",\"nick\":\"$NICK\",\"password\":\"$PV_PASSWORD\"}" 90 && ok "RENAME-1 (X): ник сменён на $NICK" || bad "RENAME-1 (X): ник не сменён"
tgx_logwait "v2: сессия запускается" 60 || bad "X: сессия не перезапущена под новым адресом"
# собеседник узнаёт о смене, перечитав журнал прежнего адреса — когда пишет на него: письмо уходит на новый адрес,
# в прежнем чате — служебное «сменил ник»
stop_pid "$BP"
tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:na-staryj-$S")
wait_log "$BL" "alice@local сменил ник на $NICK@local" 120 && ok "RENAME-1: bob увидел смену ника в прежнем чате" || bad "RENAME-1: bob не увидел смену ника"
tgx_logwait "сообщение [0-9a-f-]{36} → чат [0-9]+ \(вх\)" 90 && ok "RENAME-1 (X): письмо на прежний адрес пришло на новый" || bad "RENAME-1 (X): письмо на прежний адрес не пришло"
stop_pid "$BP"
tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="$NICK@local:posle-smeny-$S")
wait_log "$BL" "отправлено msg [0-9a-f-]{36} → $NICK@local" 90 || bad "bob: сообщение на новый адрес не отправлено"
tgx_logwait "сообщение [0-9a-f-]{36} → чат [0-9]+ \(вх\)" 90 && ok "RENAME-1 (X): сообщение на новый адрес пришло" || bad "RENAME-1 (X): сообщение на новый адрес не пришло"

# 4. DELETE-1
tgx_mark
cmd_ok "{\"op\":\"delete_account\",\"peer\":\"bob@local\",\"password\":\"$PV_PASSWORD\"}" 90 && ok "DELETE-1 (X): аккаунт поставлен на удаление" || bad "DELETE-1 (X): удаление не принято"
tgx_put parvane-deletion-answer no
tgx_fresh "$NICK@local"
tgx_logwait "удаление аккаунта: вопрос \(через [0-9]+ ч\) → нет" 90 && ok "DELETE-1 (X): при входе — вопрос с датой, «Не входить»" || bad "DELETE-1 (X): вопроса с датой нет"
tgx_logwait "v2: сессия запускается" 10 && bad "DELETE-1 (X): вход прошёл без согласия" || ok "DELETE-1 (X): вход отменён"
tgx_put parvane-deletion-answer yes
tgx_fresh "$NICK@local"
tgx_logwait "удаление аккаунта: вопрос \(через [0-9]+ ч\) → восстановить" 90 && ok "DELETE-1 (X): «Восстановить» — удаление отменено" || bad "DELETE-1 (X): восстановление не выбрано"
tgx_logwait "v2: (готов|устройству нужна привязка)" 90 && ok "DELETE-1 (X): вход после восстановления" || bad "DELETE-1 (X): вход после восстановления не прошёл"
a shell rm -f /data/local/tmp/parvane-deletion-answer
stop_pid "$BP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX ACCOUNT"
