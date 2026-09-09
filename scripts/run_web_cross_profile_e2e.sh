#!/usr/bin/env bash
# Кросс-клиентский профиль desktop → web (bio, телефон, цвет имени, личный канал).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cross_profile.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
