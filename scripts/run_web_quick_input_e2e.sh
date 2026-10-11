#!/usr/bin/env bash
# Ввод текстом в «Плане» (spec 017).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_quick_input.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
