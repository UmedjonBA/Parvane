#!/usr/bin/env bash
# Эталон телефонной версии web для Android (spec 032).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_phone_shots.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
