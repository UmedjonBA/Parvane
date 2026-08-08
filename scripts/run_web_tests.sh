#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ROOT="$ROOT/web/telegram-tt"

log() {
  printf '\n== %s ==\n' "$*"
}

cd "$WEB_ROOT"

if [[ "${PARVANE_WEB_SKIP_INSTALL:-0}" != "1" ]]; then
  log "Install exact Web dependencies"
  npm ci
fi

log "Lint and typecheck"
npm run check

log "Unit and integration tests"
npm test

log "Production build"
npm run build:production

log "Mocked build"
npm run build:mocked

log "Live-stack browser e2e"
npm run test:playwright

log "Two-browser sync and reconnect e2e"
"$ROOT/scripts/run_web_sync_e2e.sh"

log "Two-browser media and TTL e2e"
"$ROOT/scripts/run_web_media_e2e.sh"

log "Three-browser groups e2e"
"$ROOT/scripts/run_web_groups_e2e.sh"

log "Two-browser content features e2e"
"$ROOT/scripts/run_web_content_features_e2e.sh"

log "Two-browser calls e2e"
"$ROOT/scripts/run_web_calls_e2e.sh"

log "Cross-client Web <-> desktop e2e"
"$ROOT/scripts/run_web_cross_client_e2e.sh"
