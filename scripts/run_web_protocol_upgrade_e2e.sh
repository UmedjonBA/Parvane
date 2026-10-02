#!/usr/bin/env bash
# Протокол v2 (spec 007, T042): gateway требует минорную версию выше
# клиентской → web получает UPGRADE_REQUIRED и показывает нативный диалог.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_GATEWAY_ENV="PARVANE_V2_MIN_MINOR=999" \
PARVANE_E2E_EXPECT_UPGRADE=1 \
PARVANE_E2E_WEBSERVER_TIMEOUT_MS=900000 \
  "$ROOT/scripts/run_web_e2e.sh" tests/playwright/protocol-upgrade.spec.ts --project=chromium "$@"
