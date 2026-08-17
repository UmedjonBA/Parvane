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

log "Two-browser voice messages e2e"
"$ROOT/scripts/run_web_voice_e2e.sh"

log "Two-browser media kinds e2e"
"$ROOT/scripts/run_web_media_kinds_e2e.sh"

log "Three-browser groups e2e"
"$ROOT/scripts/run_web_groups_e2e.sh"

log "Three-browser group admin e2e"
"$ROOT/scripts/run_web_group_admin_e2e.sh"

log "Two-browser content features e2e"
"$ROOT/scripts/run_web_content_features_e2e.sh"

log "Two-browser content UX e2e"
"$ROOT/scripts/run_web_content_ux_e2e.sh"

log "Two-browser empty state e2e"
"$ROOT/scripts/run_web_empty_state_e2e.sh"

log "Two-browser sticker packs e2e"
"$ROOT/scripts/run_web_sticker_packs_e2e.sh"

log "B4 UX e2e (shared media, push fallback, mobile)"
"$ROOT/scripts/run_web_b4_ux_e2e.sh"

log "Two-browser polls e2e (public voters, quiz)"
"$ROOT/scripts/run_web_polls_e2e.sh"

log "Three-browser invite links e2e"
"$ROOT/scripts/run_web_invites_e2e.sh"

log "E2E keys backup e2e (C1 device migration)"
"$ROOT/scripts/run_web_keys_backup_e2e.sh"

log "Three-browser multidevice e2e (one account, two devices)"
"$ROOT/scripts/run_web_multidevice_e2e.sh"

log "Three-browser devices e2e (Settings → Devices, revoke)"
"$ROOT/scripts/run_web_devices_e2e.sh"

log "Three-browser history linking e2e (auto-link, SAS, transfer)"
"$ROOT/scripts/run_web_linking_e2e.sh"

log "Two-browser calls e2e"
"$ROOT/scripts/run_web_calls_e2e.sh"

log "Three-browser group calls e2e"
"$ROOT/scripts/run_web_group_calls_e2e.sh"

log "Cross-client Web <-> desktop e2e"
"$ROOT/scripts/run_web_cross_client_e2e.sh"
