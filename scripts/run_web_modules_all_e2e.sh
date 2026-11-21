#!/usr/bin/env bash
# Модули, часть «всё включено» (spec 041; доски `Main`, `Ribbon`, `PlusModes`, `RdNarrow`): сервер ничего не
# выключает — лента телефона из семи модулей со стрелками, «+» «Плана», «Запись в план» из меню «+», узкое окно
# компьютера 540 px (панель значков, одна колонка, «Назад» к списку).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_DISABLED_MODULES='' \
PARVANE_E2E_MODULES_PART=all \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_modules.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
