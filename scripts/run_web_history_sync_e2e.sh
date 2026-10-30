#!/usr/bin/env bash
# Синхронизация истории между устройствами аккаунта (spec 033, HIST-1/HIST-2/READ-2): удаление «у всех» и
# «только у меня», прочтение на всех своих устройствах, догон после офлайна, вход новых устройств (ключ через бота,
# ключ руками, подтверждение с другого устройства), перезагрузка — удалённое не возвращается, бейджи совпадают.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_TELEGRAM_BOT=parvane_e2e_bot \
PARVANE_TELEGRAM_SECRET=parvane-e2e-telegram-secret \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_history_sync.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
