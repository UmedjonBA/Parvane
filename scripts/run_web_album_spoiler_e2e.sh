#!/usr/bin/env bash
# Ревью UI 7 ноя 2026, этап 4 (MEDIA-2, QUOTE-1): альбом под спойлером, подпись над медиа, ответ с цитатой,
# отложенное «без звука», «Отправить, когда будет в сети».
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_album_spoiler.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
