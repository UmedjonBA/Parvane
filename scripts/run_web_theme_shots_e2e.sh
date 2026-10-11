#!/usr/bin/env bash
# Снимки экранов в тёмной и светлой теме (spec 019).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_theme_shots.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
