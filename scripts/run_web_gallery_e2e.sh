#!/usr/bin/env bash
# Галерея «экран против доски»: снимки экранов приложения под именами кадров макета (сверка с макетом).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_gallery.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
