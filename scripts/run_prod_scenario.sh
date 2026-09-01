#!/usr/bin/env bash
# Гоняет существующий e2e-сценарий против РАЗВЁРНУТОГО прод-сервера (m60-7).
# Единственная правка сценария — флаг --ignore-certificate-errors у launch
# (self-signed серт). URL берутся из env. Использование:
#   scripts/run_prod_scenario.sh e2e_web_voice.mjs
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/$1"
TMP="$ROOT/scripts/tmp_prod_$1"

node -e '
const fs = require("fs");
let s = fs.readFileSync(process.argv[1], "utf8");
if (/chromium\.launch\(\{[\s\S]*?args:\s*\[/.test(s)) {
  s = s.replace(/(chromium\.launch\(\{[\s\S]*?args:\s*\[)/, "$1\n    \x27--ignore-certificate-errors\x27,");
} else if (/chromium\.launch\(\s*\)/.test(s)) {
  s = s.replace(/chromium\.launch\(\s*\)/, "chromium.launch({ args: [\x27--ignore-certificate-errors\x27] })");
} else {
  s = s.replace(/chromium\.launch\(\{/, "chromium.launch({ args: [\x27--ignore-certificate-errors\x27], ");
}
fs.writeFileSync(process.argv[2], s);
' "$SRC" "$TMP"

export PARVANE_E2E_BASE_URL="${PARVANE_E2E_BASE_URL:-https://185.81.248.52:20443}"
export PARVANE_E2E_GATEWAY_URL="${PARVANE_E2E_GATEWAY_URL:-wss://185.81.248.52:20443/ws}"
cd "$ROOT"
set +e
node "$TMP"
code=$?
set -e
rm -f "$TMP"
exit $code
