#!/usr/bin/env bash
# Двухфакторный вход через Telegram-бота (роль бота — node через WebSocket).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_TELEGRAM_BOT=parvane_e2e_bot \
PARVANE_TELEGRAM_SECRET=parvane-e2e-telegram-secret \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_telegram_2fa.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
