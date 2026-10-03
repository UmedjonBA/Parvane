#!/usr/bin/env bash
# Кросс-клиентский звонок web ↔ desktop (аудио, настоящий движок tg_owt на десктопе).
#   run_web_cross_calls_e2e.sh [call-web-desktop|call-web2-desktop2]
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_PAIR="${1:-call-web-desktop}" \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cross_calls.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
