#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# PWA: манифест, ярлыки приложения (`?open=`), запуск без сети из кэша service worker
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_pwa.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
