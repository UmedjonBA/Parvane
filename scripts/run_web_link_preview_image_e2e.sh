#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Превью ссылки с картинкой в чате (нужен интернет: шард preview ходит на github.com)
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_link_preview_image.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
