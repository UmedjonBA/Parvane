#!/usr/bin/env bash
# Граф и холст «Заметок» по макету (spec 041 D2, spec 040): раскладка из движка, область графа, ручная расстановка,
# панель связей, «Связи» заметки с малым графом, холст из графа и «Обновить» только у него, колесо двигает поле.
# Снимки — в PARVANE_E2E_SHOT_DIR.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_notes_graph.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
