#!/usr/bin/env bash
# Галерея «экран против доски», модуль «Музыка»: за шардом music — поддельная библиотека (`fake_subsonic.mjs`).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_MUSIC_STATS_TTL_SECS=1 \
PARVANE_E2E_MUSIC=1 \
PARVANE_GALLERY="${PARVANE_GALLERY:-music}" \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_gallery.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
