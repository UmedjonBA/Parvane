#!/usr/bin/env bash
# Раздел «Знания»: заметки, граф, холст (spec 021).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_notes.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
