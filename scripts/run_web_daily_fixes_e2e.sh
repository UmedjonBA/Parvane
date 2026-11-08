#!/usr/bin/env bash
# Ревью UI 7 ноя 2026, раздел A: уведомления по умолчанию, предпросмотр ссылки над полем ввода, пересылка без
# автора и без подписи, «Отправить без звука», «Перейти к дате», избранные/недавние стикеры, вкладки поиска по типу.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_daily_fixes.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
