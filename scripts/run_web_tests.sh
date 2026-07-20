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
