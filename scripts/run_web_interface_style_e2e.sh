#!/usr/bin/env bash
# Оформление интерфейса (spec 008): «Панели» / «Классическое» — выбор при входе и в настройках.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_interface_style.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
