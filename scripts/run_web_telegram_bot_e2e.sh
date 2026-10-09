#!/usr/bin/env bash
# Настоящий Telegram-бот (backend/infra/telegram-bot) против поддельного Bot API
# (spec 015): подтверждение регистрации кнопкой, ключ восстановления в чат,
# просьба ответить ключом и приём ответа. Нужен python с websockets:
# local-workdirs/tg-bot-venv (python3 -m venv … && pip install websockets==10.4).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_TELEGRAM_BOT=parvane_e2e_bot \
PARVANE_TELEGRAM_SECRET=parvane-e2e-telegram-secret \
PARVANE_E2E_BOT_PYTHON="${PARVANE_E2E_BOT_PYTHON:-$ROOT/local-workdirs/tg-bot-venv/bin/python}" \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_telegram_bot.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
