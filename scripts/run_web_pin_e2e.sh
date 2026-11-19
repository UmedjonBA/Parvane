#!/usr/bin/env bash
# PIN хранилища по макету (spec 041 E6): включение, смена и выключение цифрами в «Профиле», экран блокировки при
# запуске, счётчик неверных вводов переживает перезагрузку, пятый неверный ввод — выход на экран входа.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_pin.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
