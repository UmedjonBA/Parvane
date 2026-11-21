#!/usr/bin/env bash
# Ключ безопасности — второй фактор входа на сервере (SECKEY-1, spec 041): заведение ключа со свежим паролем, шаг
# «вставьте ключ» на новом устройстве, отказ без ключа, вход с ключом и ключом восстановления, снятие ключа.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Страница сценария — на `localhost` (rpId WebAuthn не бывает IP-адресом); окружение раннера наследуют шарды
export PARVANE_WEBAUTHN_RP_ID=localhost
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_seckey.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
