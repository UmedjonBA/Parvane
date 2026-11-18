#!/usr/bin/env bash
# Экраны модуля «Заметки» по макету (spec 041 D1): список с папками и недавними, поиск, режимы «Просмотр / Правка /
# Рядом», кнопки разметки и подсказка ссылки, меню заметки, телефон. Снимки — в PARVANE_E2E_SHOT_DIR.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_notes_screens.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
