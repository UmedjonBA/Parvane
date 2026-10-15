#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Публичные группы (spec 023): тип «Публичная», поиск, `/@имя`, вступление без приглашения
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_public_groups.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
