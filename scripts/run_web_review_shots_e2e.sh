#!/usr/bin/env bash
# Снимки для проверки глазами (spec 012 п. 3, «План» на телефоне, локализация).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_review_shots.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
