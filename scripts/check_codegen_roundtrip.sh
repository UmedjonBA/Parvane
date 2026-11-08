#!/usr/bin/env bash
# spec 035 T059 (US6, FR-050…FR-052, contracts/codegen.md): новое сообщение схемы появляется во всех слоях само.
#
#   scripts/check_codegen_roundtrip.sh [--skip-wasm]
#
# Временно добавляет сообщение `CodegenProbe` (новый файл в пакете parvane.engine.v1 — его видит gen_bindings) и
# ничего больше не правит руками: gen_bindings порождает типы TS/C++/Kotlin, build.rs — кодек по имени типа;
# затем кругооборот proto3-JSON → байты → proto3-JSON через Rust (`type_codec`), C ABI (`pv_encode_message` /
# `pv_decode_message`, staticlib + маленькая программа на C) и WASM (node, `encodeMessage`/`decodeMessage`;
# `--skip-wasm` — без сборки WASM). В конце временный файл удаляется и выходы gen_bindings восстанавливаются.
# Тяжёлое (cargo, WASM) — под общим замком машины, как прочие раннеры (вызывающий берёт замок сам).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_WASM=0
[ "${1:-}" = "--skip-wasm" ] && SKIP_WASM=1
PROBE="$ROOT/proto/parvane/engine/v1/zz_codegen_probe.proto"
T="$(mktemp -d)"
TARGET="${CARGO_TARGET_DIR:-$ROOT/backend/target}"
restore() {
    rm -f "$PROBE"
    (cd "$ROOT/backend" && cargo run -q -p parvane-protocol --bin gen_bindings >/dev/null 2>&1) || true
    rm -rf "$T"
}
trap restore EXIT
cat > "$PROBE" <<'EOF'
// Временный файл scripts/check_codegen_roundtrip.sh — не коммитить.
syntax = "proto3";
package parvane.engine.v1;
import "parvane/core/v2/options.proto";
message CodegenProbe {
  string label = 1 [(parvane.core.v2.max_len) = 64];
  int64 big = 2;
  bytes blob = 3 [(parvane.core.v2.max_len) = 16];
  repeated uint32 nums = 4 [(parvane.core.v2.max_items) = 8];
  oneof pick {
    string word = 5 [(parvane.core.v2.max_len) = 16];
    bool flag = 6;
  }
}
EOF
JSON='{"label":"зонд","big":"9007199254740993","blob":"AQID","nums":[1,2,3],"word":"да"}'
TYPE="parvane.engine.v1.CodegenProbe"
cd "$ROOT/backend"

echo "== gen_bindings"
cargo run -q -p parvane-protocol --bin gen_bindings
for f in web/telegram-tt/src/api/parvane/v2/gen/model.ts desktop/parvane-core/include/parvane/gen/model.h android/libtd/src/main/java/org/parvane/gen/Model.kt; do
    grep -q CodegenProbe "$ROOT/$f" || { echo "FAIL: $f без CodegenProbe"; exit 1; }
done
echo "PASS: типы TS/C++/Kotlin порождены"

echo "== Rust (type_codec)"
PARVANE_CODEGEN_PROBE="$JSON" cargo test -q -p parvane-protocol --test type_codec codegen_probe_roundtrip -- --exact >/dev/null
echo "PASS: Rust"

echo "== C ABI"
cargo build -q -p parvane-protocol-ffi
cat > "$T/probe.c" <<'EOF'
#include <stdio.h>
#include <string.h>
#include "parvane_protocol.h"
int main(int argc, char **argv) {
    char *err = NULL;
    PvBytes b = pv_encode_message(argv[1], argv[2], &err);
    if (err) { fprintf(stderr, "encode: %s\n", err); return 1; }
    char *back = pv_decode_message(argv[1], b.data, b.len, &err);
    if (err || !back) { fprintf(stderr, "decode: %s\n", err ? err : "?"); return 1; }
    printf("%s\n", back);
    pv_free_string(back);
    parvane_protocol_bytes_free(b);
    return 0;
}
EOF
cc -o "$T/probe" "$T/probe.c" -I "$ROOT/backend/protocol/ffi/include" "$TARGET/debug/libparvane_protocol_ffi.a" -lpthread -ldl -lm
C_OUT="$("$T/probe" "$TYPE" "$JSON")"
[ "$(jq -cS . <<<"$C_OUT")" = "$(jq -cS . <<<"$JSON")" ] || { echo "FAIL: C ABI $C_OUT"; exit 1; }
echo "PASS: C ABI"

if [ "$SKIP_WASM" -eq 0 ]; then
    echo "== WASM"
    cargo build -q -p parvane-protocol-wasm --target wasm32-unknown-unknown --profile wasm-release
    wasm-bindgen "$TARGET/wasm32-unknown-unknown/wasm-release/parvane_protocol_wasm.wasm" --target web --out-dir "$T/wasm" --out-name parvane_protocol
    cat > "$T/probe.mjs" <<'EOF'
import { readFileSync } from 'node:fs';
const [dir, type, json] = process.argv.slice(2);
const m = await import(`${dir}/parvane_protocol.js`);
m.initSync({ module: readFileSync(`${dir}/parvane_protocol_bg.wasm`) });
process.stdout.write(m.decodeMessage(type, m.encodeMessage(type, json)));
EOF
    W_OUT="$(node "$T/probe.mjs" "$T/wasm" "$TYPE" "$JSON")"
    [ "$(jq -cS . <<<"$W_OUT")" = "$(jq -cS . <<<"$JSON")" ] || { echo "FAIL: WASM $W_OUT"; exit 1; }
    echo "PASS: WASM"
fi
echo "ОК: новое сообщение прошло все слои без ручной правки"
