#!/usr/bin/env bash
# Ключ восстановления через Telegram-бота (spec 015): ключ уходит владельцу в
# Telegram, новое устройство входит по ответу боту — без других устройств.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_TELEGRAM_BOT=parvane_e2e_bot \
PARVANE_TELEGRAM_SECRET=parvane-e2e-telegram-secret \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_telegram_recovery.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
