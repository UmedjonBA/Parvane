#!/usr/bin/env bash
# Markdown заметок (MD-1): тестовый файл со всеми конструкциями, правка с живым просмотром (широкий экран и телефон).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_markdown.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
