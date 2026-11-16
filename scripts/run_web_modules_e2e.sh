#!/usr/bin/env bash
# Модули (spec 041, этап A; правило MODULES-1): боковая панель и лента от списка модулей устройства, экран
# «Профиль → Модули», выключенный модуль пропадает из навигации и поиска и не возвращается после перезагрузки,
# модуль, выключенный администратором сервера (здесь — «Заметки»), включить нельзя.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_DISABLED_MODULES="${PARVANE_E2E_DISABLED_MODULES:-notes}" \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_modules.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
