#!/usr/bin/env bash
# Оболочка по доскам `XpStart`, `ZdNav` (spec 041): первый запуск (выбор модулей), горячие клавиши, окно
# «Нужно обновить приложение», шторка выхода.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_first_run.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
