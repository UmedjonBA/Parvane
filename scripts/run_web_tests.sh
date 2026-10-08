#!/usr/bin/env bash

set -Eeuo pipefail
# CSP (P-32): сборка для e2e ходит в локальный gateway — только loopback
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ROOT="$ROOT/web/telegram-tt"

log() {
  printf '\n== %s ==\n' "$*"
}

# Известный красный шаг: раннер падает и на чистом HEAD (см. раздел Gate status
# в web/WEB-A4-MATRIX.md). Под `set -Eeuo pipefail` он обрывал весь прогон, и
# идущие следом раннеры не выполнялись ни разу. Запускаем нефатально и
# докладываем итог в конце.
KNOWN_RED_FAILED=()
KNOWN_RED_PASSED=()

known_red() {
  local reason="$1"
  shift
  local name
  name="$(basename "$1")"
  if "$@"; then
    printf '\n!! %s: известный красный шаг ПРОШЁЛ — снять пометку известного падения\n' "$name"
    KNOWN_RED_PASSED+=("$name")
  else
    printf '\n!! %s: ИЗВЕСТНОЕ ПАДЕНИЕ (%s) — прогон продолжается\n' "$name" "$reason"
    KNOWN_RED_FAILED+=("$name ($reason)")
  fi
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
# 15–16 сен шаг был известным красным (пикер New Channel, e2e_web_group_admin.mjs:185);
# 17 сен прошёл 2/2 — пометка known_red снята, при повторном падении вернуть обёртку
"$ROOT/scripts/run_web_group_admin_e2e.sh"
"$ROOT/scripts/run_web_group_info_e2e.sh"

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

log "Notify (mute) and profile fields across devices e2e"
"$ROOT/scripts/run_web_notify_profile_e2e.sh"

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

log "Cross-client multidevice + linking Web <-> desktop e2e"
"$ROOT/scripts/run_web_cross_multidevice_e2e.sh"

log "Cross-client profile desktop -> web e2e (bio, phone, name color, personal channel)"
"$ROOT/scripts/run_web_cross_profile_e2e.sh"

log "Two-browser long video streaming and integrity e2e (thumbnail, seek, tampering)"
"$ROOT/scripts/run_web_video_stream_e2e.sh"

log "Two-browser contacts e2e"
"$ROOT/scripts/run_web_contacts_e2e.sh"

log "Two-browser delete chat e2e"
"$ROOT/scripts/run_web_delete_chat_e2e.sh"

log "Two-browser forward photo e2e"
"$ROOT/scripts/run_web_forward_photo_e2e.sh"

log "Two-browser live location e2e"
"$ROOT/scripts/run_web_live_location_e2e.sh"

log "Saved Messages e2e"
"$ROOT/scripts/run_web_saved_messages_e2e.sh"

log "Saved Messages on a second linked device e2e"
"$ROOT/scripts/run_web_saved_second_device_e2e.sh"

log "Offline device catch-up e2e (conformance: device was absent)"
"$ROOT/scripts/run_web_offline_device_e2e.sh"

log "Session expiry e2e"
"$ROOT/scripts/run_web_session_expiry_e2e.sh"

log "Language switch e2e"
"$ROOT/scripts/run_web_language_e2e.sh"

log "Email registration e2e"
"$ROOT/scripts/run_web_email_e2e.sh"

log "Telegram bot registration e2e"
"$ROOT/scripts/run_web_telegram_e2e.sh"

log "Telegram two-factor login e2e"
"$ROOT/scripts/run_web_telegram_2fa_e2e.sh"

log "Per-callee ring cap: the caller is told why the call did not go out"
"$ROOT/scripts/run_web_call_limit_e2e.sh"

log "Rejected saved token: sign-in screen, then back to work (E6-1)"
"$ROOT/scripts/run_web_auth_reject_e2e.sh"

log "Honest native UI e2e (hidden unsupported actions, no unimplemented methods)"
"$ROOT/scripts/run_web_honest_ui_e2e.sh"

log "Gateway rate limit e2e"
"$ROOT/scripts/run_gateway_rate_limit_e2e.sh"
"$ROOT/scripts/run_web_interface_style_e2e.sh"
"$ROOT/scripts/run_web_planner_e2e.sh"

log "Cross-client features Web <-> desktop e2e (readers, live location, revoke)"
"$ROOT/scripts/run_web_cross_features_e2e.sh"

log "Cross-client custom emoji packs Web <-> desktop e2e"
"$ROOT/scripts/run_web_cross_emoji_e2e.sh"

log "Итог"
if [[ ${#KNOWN_RED_FAILED[@]} -eq 0 && ${#KNOWN_RED_PASSED[@]} -eq 0 ]]; then
  printf 'все раннеры зелёные\n'
fi
for name in ${KNOWN_RED_FAILED[@]+"${KNOWN_RED_FAILED[@]}"}; do
  printf 'ИЗВЕСТНОЕ ПАДЕНИЕ: %s\n' "$name"
done
for name in ${KNOWN_RED_PASSED[@]+"${KNOWN_RED_PASSED[@]}"}; do
  printf 'НЕОЖИДАННО ЗЕЛЁНЫЙ (снять пометку): %s\n' "$name"
done
