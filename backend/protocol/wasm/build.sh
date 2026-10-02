#!/usr/bin/env bash
# Сборка WASM-движка для web (spec 007, T054): cargo (профиль wasm-release)
# → wasm-bindgen (--target web) → wasm-opt -Oz. Результат —
# web/telegram-tt/src/lib/parvane-protocol/ (коммитится вместе с web).
# Нужны: rustup target wasm32-unknown-unknown, wasm-bindgen-cli той же версии,
# что wasm-bindgen в Cargo.lock, wasm-opt (binaryen) в PATH или ~/.local/bin.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$REPO/web/telegram-tt/src/lib/parvane-protocol"
cd "$REPO/backend"
cargo build -p parvane-protocol-wasm --target wasm32-unknown-unknown --profile wasm-release
WASM="target/wasm32-unknown-unknown/wasm-release/parvane_protocol_wasm.wasm"
mkdir -p "$OUT"
wasm-bindgen "$WASM" --target web --out-dir "$OUT" --out-name parvane_protocol
OPT="$(command -v wasm-opt || echo "$HOME/.local/bin/wasm-opt")"
"$OPT" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  "$OUT/parvane_protocol_bg.wasm" -o "$OUT/parvane_protocol_bg.wasm"
ls -la "$OUT"
echo "gzip: $(gzip -9c "$OUT/parvane_protocol_bg.wasm" | wc -c) байт"
