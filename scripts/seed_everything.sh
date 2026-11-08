#!/usr/bin/env bash
# Наполнение «всё понемногу» (spec 035, T006) на выдуманных данных: изолированный стек (как run_web_e2e.sh) + web,
# сценарий scripts/e2e_web_seed_everything.mjs. Выход — PARVANE_SEED_OUT (по умолчанию local-workdirs/spec035/seed-web):
# профили браузера и копия баз шардов (profiles/), выгрузки auditDump и баз (audit/), сводка шагов (seed-summary.json),
# счётчики SC-009 web (counters-web.json). Desktop и android — desktop/verify_seed_everything.sh,
# android/tgx_seed_everything_flow.sh. Тяжёлый прогон: по одному, под heavy.lock (корневой CLAUDE.md).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PARVANE_SEED_OUT="${PARVANE_SEED_OUT:-$ROOT/local-workdirs/spec035/seed-web}"
mkdir -p "$PARVANE_SEED_OUT"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_seed_everything.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
