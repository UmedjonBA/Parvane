#!/usr/bin/env bash
# Фон чата (spec 014): фоны с узором, размытие своей картинки, галерея после перезагрузки.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_chat_background.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
