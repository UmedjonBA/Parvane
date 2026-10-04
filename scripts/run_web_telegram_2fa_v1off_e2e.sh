#!/usr/bin/env bash
# Двухфакторный вход через Telegram-бота на сервере с ОТКЛЮЧЁННЫМ v1 (T134, правило
# E6-1): тот же сценарий, что run_web_telegram_2fa_e2e.sh, gateway —
# PARVANE_V1_MODE=disabled; роль бота — `nats req` напрямую в шину.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_V1_OFF=1 \
PARVANE_E2E_GATEWAY_ENV="PARVANE_V1_MODE=disabled ${PARVANE_E2E_GATEWAY_ENV:-}" \
  "$ROOT/scripts/run_web_telegram_2fa_e2e.sh"
