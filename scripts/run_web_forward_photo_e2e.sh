#!/usr/bin/env bash
# Пересылка фото в другой чат: перевыгрузка блоба с грантами для нового
# получателя — фото грузится у него сразу и после reload.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_forward_photo.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
