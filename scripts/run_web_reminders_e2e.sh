#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Напоминания «Плана»: будильник на сервере, показ на двух открытых устройствах, одно сообщение в «Избранном»
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_reminders.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
