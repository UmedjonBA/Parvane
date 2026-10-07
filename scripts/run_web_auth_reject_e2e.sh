#!/usr/bin/env bash
# Отказ сохранённого JWT (E6-1, T178): identity перезапускается с новым ключом подписи,
# клиент снимает сессию и показывает экран входа, после пароля работает дальше.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_auth_reject.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
