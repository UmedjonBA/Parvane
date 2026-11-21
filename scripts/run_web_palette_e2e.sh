#!/usr/bin/env bash
# Общий поиск (палитра Ctrl+K): команды, заметки, файлы, записи «Плана», чаты, треки «Музыки» (поддельная
# библиотека — свои порты, чтобы не мешать сценарию `music`, идущему параллельно).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_MUSIC=1 \
PARVANE_E2E_MUSIC_LIBRARY_PORT=19461 \
PARVANE_E2E_MUSIC_HTTP_PORT=19462 \
PARVANE_E2E_MUSIC_FETCH_PORT=19463 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_palette.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
