#!/usr/bin/env bash
# Чаты по макету (spec 041 E5): шапка списка чатов, меню сообщения с действиями модулей, шторка вложений.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_chat_design.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
