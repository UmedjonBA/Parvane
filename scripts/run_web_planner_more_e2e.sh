#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# «План» по доскам spec 041 E1: расписание текстом, поиск, свободное время, «Задачи», тренировка в «Здоровье»
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_planner_more.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
