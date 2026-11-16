#!/usr/bin/env bash
# Модуль «Здоровье» (spec 038, 041; правила HEALTH-1…3): запись одной строкой с показом разбора, сводка из
# движка, цель, удаление, перезагрузка, второе устройство аккаунта видит те же записи.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_health.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
