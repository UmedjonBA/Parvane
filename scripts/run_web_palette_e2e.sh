#!/usr/bin/env bash
# Общий поиск (палитра Ctrl+K): команды, заметки, записи «Плана», чаты.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_palette.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
