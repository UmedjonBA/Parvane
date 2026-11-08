#!/usr/bin/env bash
# spec 035 T111: «В избранное» у стикера в ленте и избранное на втором web-устройстве (FAVED_STICKER).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_fave_sticker.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
