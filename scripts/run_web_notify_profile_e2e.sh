#!/usr/bin/env bash
# Уведомления (мут) и профильные поля кросс-девайс: два web-устройства alice + bob.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_notify_profile.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
