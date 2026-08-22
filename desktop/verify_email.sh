#!/usr/bin/env bash
# Parvane desktop — РЕГИСТРАЦИЯ ЧЕРЕЗ ПОЧТУ (PARVANE_EMAIL_REQUIRED=1, dev-SMTP:
# код в логе identity). carol: адрес+пароль → email → код → вход. Неверный код
# отклоняется; релогин подтверждённого — без кода.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-email}" PARVANE_EMAIL_REQUIRED=1
C="$SB/carol"; CODEF="$SB/code.txt"
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOEMAIL=carol@example.com PARVANE_AUTOCODE_FILE="$CODEF")
wait_log "$SB/identity.log" "код подтверждения для carol@example.com: [0-9]{6}" 40 && ok "identity выслал код (dev-режим)" || bad "кода нет в логе identity"
CODE=$(grep -oE "код подтверждения для carol@example.com: [0-9]{6}" "$SB/identity.log" | tail -1 | grep -oE "[0-9]{6}$")
# Сначала неверный код → клиент должен показать ошибку и не войти.
echo "000000" > "$CODEF"; sleep 4
grep -q "login OK for carol@local" "$C/td/log.txt" && bad "вошёл с неверным кодом" || ok "неверный код не пускает"
echo "$CODE" > "$CODEF"
wait_log "$C/td/log.txt" "login OK for carol@local" 40 && ok "вход после подтверждения кода" || bad "вход не удался"
V=$(sqlite3 "$SB/identity.db" "SELECT email_verified FROM users WHERE username='carol@local';")
[ "$V" = "1" ] && ok "email_verified=1" || bad "email_verified=$V"
stop_pid "$PC"
# Релогин без кода (аккаунт подтверждён).
rm -f "$CODEF"
PC=$(start_client "$SB/carol2" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$SB/carol2/td/log.txt" "login OK for carol@local" 40 && ok "релогин без кода" || bad "релогин не удался"
stop_pid "$PC"; stack_stop
finish "EMAIL"
