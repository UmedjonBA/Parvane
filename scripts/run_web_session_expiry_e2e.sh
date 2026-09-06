#!/usr/bin/env bash
# «Оставаться в системе»: автологин у свежей сессии, экран пароля после суток
# без активности, вход по паролю восстанавливает сессию.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_session_expiry.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
