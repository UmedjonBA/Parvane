#!/usr/bin/env bash
# Сессия без ежедневного пароля (SESSION-1): токен живёт минуту, gateway сверяет его каждые 5 с — вкладка
# продлевает сессию сама, перезагрузка и двое суток без активности пароль не спрашивают; после окна продления
# (180 суток тишины) — экран пароля, вход по паролю восстанавливает сессию.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_SESSION_TTL_SECS=60 \
PARVANE_E2E_GATEWAY_ENV="PARVANE_GATEWAY_REVERIFY_SECS=5 ${PARVANE_E2E_GATEWAY_ENV:-}" \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_session_expiry.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
