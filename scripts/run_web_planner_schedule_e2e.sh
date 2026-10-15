#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# «План»: расписание на неделю текстом и «Очистить план»
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_planner_schedule.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
