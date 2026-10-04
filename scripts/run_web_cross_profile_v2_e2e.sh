#!/usr/bin/env bash
# T179: тот же сценарий, что run_web_cross_profile_e2e.sh, но оба клиента идут по протоколу v2 (по умолчанию).

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_PROTO=v2 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cross_profile.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
