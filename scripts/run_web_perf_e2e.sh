#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Замеры производительности web (не проверка): старт, разделы, окна, набор, граф,
# холст, простой, CPU×4. Итог — таблица в журнале и perf.json в PARVANE_E2E_SHOT_DIR
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_perf.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
