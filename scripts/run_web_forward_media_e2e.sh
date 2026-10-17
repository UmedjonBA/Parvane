#!/usr/bin/env bash
# Пересылка видео, файла и голосового в другой чат: блоб перевыгружается под
# новым секретом скачивания (CAP-1) — у нового получателя видео играет, файл
# скачивается побайтно, голосовое воспроизводится, и после reload тоже.
# Нужен ffmpeg (VP9-фикстура видео).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_forward_media.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
