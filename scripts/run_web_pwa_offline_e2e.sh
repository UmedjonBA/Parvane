#!/usr/bin/env bash
# PWA (spec 041 F1): установка, запуск без сети, обновление после выкладки — `e2e_web_pwa_offline.mjs`.
# Сценарию нужна вторая сборка с другими именами частей кода: она собирается здесь во временный каталог
# (другой идентификатор сборки), либо берётся готовая из PARVANE_E2E_PWA_NEXT_DIST.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Те же переменные сборки, что ставит `run_web_e2e.sh` основной сборке
export VITE_PARVANE_DIAG_HOOKS=1
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"

if [[ -z "${PARVANE_E2E_PWA_NEXT_DIST:-}" ]]; then
  PARVANE_E2E_PWA_NEXT_DIST="$(mktemp -d /tmp/parvane-pwa-next.XXXXXX)"
  trap 'case "$PARVANE_E2E_PWA_NEXT_DIST" in /tmp/parvane-pwa-next.*) rm -rf "$PARVANE_E2E_PWA_NEXT_DIST" ;; esac' EXIT
  printf '\n== Build the second Web bundle (the "next release") ==\n'
  (cd "$ROOT/web/telegram-tt" \
    && PARVANE_BUILD_ID="pwa-next-$(date +%s)" node_modules/.bin/vite build \
      --outDir "$PARVANE_E2E_PWA_NEXT_DIST" --emptyOutDir)
fi
export PARVANE_E2E_PWA_NEXT_DIST

PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_pwa_offline.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
