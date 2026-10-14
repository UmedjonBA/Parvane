#!/usr/bin/env bash
# Статья в чат (ARTICLE-1): заметка «Знаний» пунктом «Статья», окно чтения, сохранение в заметки.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_article.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
