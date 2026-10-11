#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Пределы облака занижены: сценарий проверяет отказ файла больше предела
# (3 МБ шифртекста) без гигабайтных фикстур
PARVANE_E2E_CLOUD_DRIVE_MAX_FILE_BYTES="${PARVANE_E2E_CLOUD_DRIVE_MAX_FILE_BYTES:-3000000}" \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cloud.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
