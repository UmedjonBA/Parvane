#!/usr/bin/env bash

set -Eeuo pipefail
# CSP (P-32): сборка для e2e ходит в локальный gateway — только loopback
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"

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

log "Three-browser forward video, file and voice e2e"
"$ROOT/scripts/run_web_forward_media_e2e.sh"
log "Data export archive e2e"
"$ROOT/scripts/run_web_export_e2e.sh"
log "Username change e2e"
"$ROOT/scripts/run_web_rename_e2e.sh"
log "Account deletion and restore e2e"
"$ROOT/scripts/run_web_account_delete_e2e.sh"

log "Two-browser live location e2e"
"$ROOT/scripts/run_web_live_location_e2e.sh"

log "Saved Messages e2e"
"$ROOT/scripts/run_web_saved_messages_e2e.sh"

log "Saved Messages on a second linked device e2e"
"$ROOT/scripts/run_web_saved_second_device_e2e.sh"

log "Planner server sync on two devices e2e (spec 010)"
"$ROOT/scripts/run_web_planner_sync_e2e.sh"

log "Task offer in chat e2e (spec 011, TASK-1)"
"$ROOT/scripts/run_web_task_offer_e2e.sh"

log "Article in chat e2e (ARTICLE-1)"
"$ROOT/scripts/run_web_article_e2e.sh"

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

log "Recovery key via Telegram: a new device joins by replying to the bot"
"$ROOT/scripts/run_web_telegram_recovery_e2e.sh"

# Настоящий бот против поддельного Bot API — нужен python с websockets (см. раннер)
if [[ -x "${PARVANE_E2E_BOT_PYTHON:-$ROOT/local-workdirs/tg-bot-venv/bin/python}" ]]; then
  log "Telegram bot (real bot, fake Bot API)"
  "$ROOT/scripts/run_web_telegram_bot_e2e.sh"
else
  log "Telegram bot e2e SKIPPED: no python with websockets (local-workdirs/tg-bot-venv)"
fi

log "Per-callee ring cap: the caller is told why the call did not go out"
"$ROOT/scripts/run_web_call_limit_e2e.sh"

log "Rejected saved token: sign-in screen, then back to work (E6-1)"
"$ROOT/scripts/run_web_auth_reject_e2e.sh"

log "Honest native UI e2e (hidden unsupported actions, no unimplemented methods)"
"$ROOT/scripts/run_web_honest_ui_e2e.sh"

log "Gateway rate limit e2e"
"$ROOT/scripts/run_gateway_rate_limit_e2e.sh"
"$ROOT/scripts/run_web_chat_background_e2e.sh"
"$ROOT/scripts/run_web_planner_e2e.sh"
"$ROOT/scripts/run_web_cloud_e2e.sh"
"$ROOT/scripts/run_web_cloud_sync_e2e.sh"
"$ROOT/scripts/run_web_cloud_chat_e2e.sh"
"$ROOT/scripts/run_web_cloud_share_e2e.sh"
"$ROOT/scripts/run_web_cloud_links_e2e.sh"

log "Cross-client features Web <-> desktop e2e (readers, live location, revoke)"
"$ROOT/scripts/run_web_cross_features_e2e.sh"

log "Cross-client custom emoji packs Web <-> desktop e2e"
"$ROOT/scripts/run_web_cross_emoji_e2e.sh"

log "Итог"
printf 'все раннеры зелёные\n'
