#!/usr/bin/env bash
# «Заметки» на двух устройствах: очередь текстов без связи и экран расхождения правок (spec 041 хвосты D, spec 040 T9)
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_notes_sync.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
