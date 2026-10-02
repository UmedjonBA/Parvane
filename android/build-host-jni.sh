#!/usr/bin/env bash
# Хостовая libparvane_protocol_jni.so для JVM-тестов шва (spec 007, T067):
# движок v2 (C ABI, cargo build -p parvane-protocol-ffi — debug, тот же, что
# у desktop/parvane-core) + protocol_jni.cpp/v2_bridge.h + v2_content.cpp.
# Выход: android/.build/host-jni/libparvane_protocol_jni.so (путь — в stdout).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
JDK="${JDK_HOME:-${JAVA_HOME:-/mnt/hdd/ub/android/jdk-17}}"
OUT="$ROOT/.build/host-jni"
PROTO_LIB="$REPO/backend/target/debug/libparvane_protocol_ffi.a"
# cargo сам решает, нужна ли пересборка (обычно уже собрано desktop/parvane-core)
(cd "$REPO/backend" && cargo build -p parvane-protocol-ffi -j "${CARGO_JOBS:-4}" >&2)
[ -f "$PROTO_LIB" ] || { echo "нет $PROTO_LIB" >&2; exit 3; }
cmake -S "$ROOT/jni/host" -B "$OUT" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DJDK_HOME="$JDK" -DPARVANE_PROTOCOL_LIB="$PROTO_LIB" >&2
ninja -C "$OUT" >&2
echo "$OUT/libparvane_protocol_jni.so"
