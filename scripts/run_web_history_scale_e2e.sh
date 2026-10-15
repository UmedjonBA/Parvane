#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Замер окна истории чата (п. 21 плана 15 окт): перезагрузка, память, открытие чата при большой истории
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_history_scale.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
