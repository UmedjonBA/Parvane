#!/usr/bin/env bash
# «Избранное»: отправка самому себе без ошибки E2E и persist после reload.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_saved_messages.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
