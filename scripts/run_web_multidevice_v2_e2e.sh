#!/usr/bin/env bash
# Мультидевайс по протоколу v2 (T179): те же шаги, что run_web_multidevice_e2e.sh,
# но второе устройство привязывается (LINK-1 v2), а ссылка группы — запись журнала группы.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_PROTO=v2 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_multidevice.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
