#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# P-42: identity пишет код подтверждения в лог только в dev-режиме
# (PARVANE_DEV=1); сценарий читает код из identity.log
PARVANE_EMAIL_REQUIRED=1 \
PARVANE_DEV=1 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_email_register.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
