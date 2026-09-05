#!/usr/bin/env bash
# Кросс-проверка web↔desktop фич от 2026-09-02: «read at» из msg.chat.readers,
# live-локация web→desktop (приём + правка позиции), отзыв устройства desktop
# из web Settings→Devices гасит JWT desktop (sync ошибка).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cross_features.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
