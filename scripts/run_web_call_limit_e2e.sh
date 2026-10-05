#!/usr/bin/env bash
# Потолок вызовов адресату (шард call, P-35): сверх лимита звонящий видит понятную причину.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_RINGING_MAX=2 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_call_limit.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
