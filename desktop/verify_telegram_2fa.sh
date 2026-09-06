#!/usr/bin/env bash
# Parvane — регистрация через Telegram-бота и двухфакторный вход (десктоп).
# identity в режиме telegram (PARVANE_TELEGRAM_BOT+SECRET); «бот» — nats req
# identity.telegram.confirm. Сценарий:
#   1) новый ник → экран Telegram (token в логе) → бот подтверждает → вход;
#   2) PARVANE_AUTOTWOFA=on включает 2FA;
#   3) новое устройство (другой workdir): пароль верен → экран Telegram;
#      чужой Telegram отклонён; свой — подтверждает → вход;
#   4) то же устройство повторно — доверенное, без Telegram;
#   5) выключение 2FA → обычный вход с нового устройства.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
NATS="${NATS_BIN:-$HOME/.local/bin/nats}"
SB="$(mktemp -d /tmp/pv-2fa.XXXXXX)"
SECRET="desktop-e2e-telegram-secret"
stack_start "$SB" PARVANE_TELEGRAM_BOT=parvane_e2e_bot PARVANE_TELEGRAM_SECRET="$SECRET" PARVANE_DOMAIN=local
USER="tfa$(date +%s)"
confirm() { # confirm <token> <telegram_id>
  "$NATS" --server nats://127.0.0.1:4222 req identity.telegram.confirm \
    "{\"secret\":\"$SECRET\",\"token\":\"$1\",\"telegram_id\":$2,\"telegram_name\":\"tg$2\"}" 2>/dev/null
}
token_of() { grep -oE "ждём подтверждения, token=[A-Za-z0-9_-]+" "$1" | tail -1 | sed 's/.*token=//'; }

# 1) регистрация: голый ник, без домена — клиент сам подставит @local
D1="$SB/dev1"; mkdir -p "$D1/td"
P1=$(start_client "$D1" "$USER")
wait_log "$D1/td/log.txt" "Telegram регистрация — ждём подтверждения" 40 && ok "регистрация: экран Telegram" || bad "регистрация: нет экрана Telegram"
T=$(token_of "$D1/td/log.txt")
[ -n "$T" ] && ok "токен регистрации в логе" || bad "нет токена"
R=$(confirm "$T" 3001); echo "$R" | grep -q '"ok":true' && ok "бот подтвердил регистрацию" || bad "бот не подтвердил: $R"
wait_log "$D1/td/log.txt" "E2E-устройство готово" 40 && ok "после подтверждения клиент вошёл сам ($USER@local)" || bad "клиент не вошёл после подтверждения"
grep -q "autologin hook for $USER" "$D1/td/log.txt" || bad "автологин не сработал"
stop_pid "$P1"

# 2) включить 2FA (тумблер настроек → identity.user.twofa)
P1=$(start_client "$D1" "$USER" PARVANE_AUTOTWOFA=on)
wait_log "$D1/td/log.txt" "autotwofa → enabled=1 ok=1" 40 && ok "2FA включён" || bad "2FA не включился: $(grep autotwofa "$D1/td/log.txt" | tail -1)"
stop_pid "$P1"

# 3) новое устройство → Telegram-подтверждение входа
D2="$SB/dev2"; mkdir -p "$D2/td"
P2=$(start_client "$D2" "$USER@local")
wait_log "$D2/td/log.txt" "Telegram вход — ждём подтверждения" 40 && ok "новое устройство: экран подтверждения входа" || bad "новое устройство: нет экрана Telegram"
T=$(token_of "$D2/td/log.txt")
R=$(confirm "$T" 3002); echo "$R" | grep -q '"ok":false' && ok "чужой Telegram отклонён" || bad "чужой Telegram принят: $R"
sleep 3; grep -q "E2E-устройство готово" "$D2/td/log.txt" && bad "вошёл без подтверждения" || ok "без подтверждения входа нет"
R=$(confirm "$T" 3001); echo "$R" | grep -q '"ok":true' && ok "свой Telegram подтвердил вход" || bad "свой Telegram отклонён: $R"
wait_log "$D2/td/log.txt" "E2E-устройство готово" 40 && ok "вход завершён после подтверждения" || bad "вход не завершился"
stop_pid "$P2"

# 4) то же устройство — доверенное
P2=$(start_client "$D2" "$USER@local")
wait_log "$D2/td/log.txt" "E2E-устройство готово" 40 && ok "доверенное устройство вошло без Telegram" || bad "доверенное устройство не вошло"
grep -q "ждём подтверждения" "$D2/td/log.txt" && bad "доверенное устройство снова просит Telegram" || ok "повторного подтверждения не было"
stop_pid "$P2"

# 5) выключить 2FA → новое устройство входит сразу
P1=$(start_client "$D1" "$USER" PARVANE_AUTOTWOFA=off)
wait_log "$D1/td/log.txt" "autotwofa → enabled=0 ok=1" 40 && ok "2FA выключен" || bad "2FA не выключился"
stop_pid "$P1"
D3="$SB/dev3"; mkdir -p "$D3/td"
P3=$(start_client "$D3" "$USER")
wait_log "$D3/td/log.txt" "E2E-устройство готово" 40 && ok "после выключения 2FA — обычный вход" || bad "обычный вход не прошёл"
grep -q "ждём подтверждения" "$D3/td/log.txt" && bad "просит Telegram при выключенном 2FA" || true
stop_pid "$P3"
stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "TELEGRAM 2FA"
