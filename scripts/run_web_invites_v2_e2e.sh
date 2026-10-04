#!/usr/bin/env bash
# Ссылки-приглашения группы v2 (T179): те же шаги, что run_web_invites_e2e.sh,
# но клиенты идут по протоколу v2 — ссылки `/join/<link_id>#<секрет>` из журнала группы.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_PROTO=v2 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_invites.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
