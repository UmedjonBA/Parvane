#!/usr/bin/env bash
# История v1 после отключения v1 (T182): gateway перезапускается посреди сценария
# с PARVANE_V1_MODE=disabled, недоставленное сообщение v1 приходит записью LegacyV1.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Сценарий сам задаёт режим v1 gateway — общий режим «без v1» не для него
PARVANE_E2E_V1_OFF=0 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_legacy_v1off.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
