#!/usr/bin/env bash
# Язык интерфейса Web: переключение English ↔ Русский в Settings → Language,
# persist после reload, перевод старого lang-провайдера (модалка удаления чата).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_language.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
