#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Оба клиента — по протоколу v2 (T110: другого нет); пары web ↔ desktop по сценариям
# протокола — scripts/run_protocol_mixed_e2e.sh web2-desktop2.
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cross_client.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
