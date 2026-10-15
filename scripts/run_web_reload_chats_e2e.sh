#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Список чатов после перезагрузки в Chromium и Firefox (жалоба 15 окт 2026: вечная загрузка до повторного обновления)
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_reload_chats.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
