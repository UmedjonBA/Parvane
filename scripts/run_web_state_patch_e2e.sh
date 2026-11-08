#!/usr/bin/env bash
# spec 035 T110: правки разных полей папки и контакта с двух web-устройств без связи сходятся (state.v2, патч).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_state_patch.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
