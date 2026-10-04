#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Сценарий сверяет группы по модели v1 (GROUP-1: нотис, ревизия, UUID группы) — закреплён за v1 на обоих клиентах
# (v2 по умолчанию, T135); пары v2 web ↔ desktop — scripts/run_protocol_mixed_e2e.sh web2-desktop2.
export PARVANE_E2E_PROTO=v1 PARVANE_PROTO_V2=0
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cross_client.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
