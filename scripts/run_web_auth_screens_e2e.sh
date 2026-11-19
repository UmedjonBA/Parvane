#!/usr/bin/env bash
# Экраны входа по макету (spec 041 E4): форма входа, шаг пароля, регистрация, язык и тема, телефон.
#   run_web_auth_screens_e2e.sh [email|telegram] — экран кода либо экран Telegram (сервер с подтверждением)
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-base}"
case "$MODE" in
  email) export PARVANE_EMAIL_REQUIRED=1 PARVANE_DEV=1 ;;
  telegram) export PARVANE_TELEGRAM_BOT=parvane_e2e_bot PARVANE_TELEGRAM_SECRET=parvane-e2e-telegram-secret ;;
esac
PARVANE_E2E_AUTH_MODE="$MODE" \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_auth_screens.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
