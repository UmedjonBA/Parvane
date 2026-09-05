#!/usr/bin/env bash
# Контакты Web: пустой список по умолчанию, «Новый контакт» по нику,
# собеседник с перепиской, persist после reload.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_contacts.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
