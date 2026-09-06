#!/usr/bin/env bash
# Лимит частоты gateway: флуд publish отклоняется rate_limited, обычный темп проходит.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_gateway_rate_limit.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
