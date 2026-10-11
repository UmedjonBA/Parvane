#!/usr/bin/env bash
# «Здоровье» в «Плане» (spec 020).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_health.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
