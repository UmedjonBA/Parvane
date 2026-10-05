#!/usr/bin/env bash
# Отказ сохранённого токена на сервере без v1 (E6-1): клиент уходит на экран входа,
# после пароля работает дальше. identity перезапускается посреди сценария с новым
# ключом подписи JWT.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_V1_OFF=1 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_auth_reject.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
