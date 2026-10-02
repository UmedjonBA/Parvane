#!/usr/bin/env bash
# Собирает libparvane_core.a под один Android ABI:
#  1) cargo-ndk → libparvane_e2e.a (Rust vodozemac, v1) и libparvane_protocol_ffi.a
#     (движок протокола v2, spec 007, C ABI) под target;
#  2) cmake+ninja (android/jni) → libparvane_core.a, линкует OpenSSL(ABI)+e2e.
# Требует: ANDROID_NDK_HOME, cargo-ndk, собранный OpenSSL (build-openssl.sh).
set -Eeuo pipefail
NDK="${ANDROID_NDK_HOME:?задай ANDROID_NDK_HOME}"
ABI="${1:-arm64-v8a}"
API="${ANDROID_API:-24}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
OSSL="$ROOT/prebuilt/openssl/$ABI"
[ -f "$OSSL/lib/libcrypto.a" ] || { echo "нет OpenSSL под $ABI — сначала build-openssl.sh"; exit 2; }

case "$ABI" in
  arm64-v8a)   RUST_TARGET=aarch64-linux-android ;;
  armeabi-v7a) RUST_TARGET=armv7-linux-androideabi ;;
  x86_64)      RUST_TARGET=x86_64-linux-android ;;
  x86)         RUST_TARGET=i686-linux-android ;;
  *) echo "неизвестный ABI: $ABI"; exit 2 ;;
esac

echo "== 1/2 cargo-ndk: parvane-e2e + parvane-protocol-ffi для $ABI ($RUST_TARGET) =="
cd "$REPO/backend"
# Один вызов cargo — одна сборка общих зависимостей; -j по CARGO_JOBS (16 ГБ ОЗУ)
cargo ndk -t "$ABI" --platform "$API" build -p parvane-e2e -p parvane-protocol-ffi --release -j "${CARGO_JOBS:-4}"
E2E_LIB="$REPO/backend/target/$RUST_TARGET/release/libparvane_e2e.a"
PROTO_LIB="$REPO/backend/target/$RUST_TARGET/release/libparvane_protocol_ffi.a"
[ -f "$E2E_LIB" ] || { echo "нет $E2E_LIB"; exit 3; }
[ -f "$PROTO_LIB" ] || { echo "нет $PROTO_LIB"; exit 3; }

echo "== 2/2 cmake+ninja: parvane_core для $ABI =="
BUILD="$ROOT/.build/core-$ABI"
rm -rf "$BUILD"; mkdir -p "$BUILD"
cmake -S "$ROOT/jni" -B "$BUILD" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" \
  -DANDROID_PLATFORM="android-$API" \
  -DPARVANE_OPENSSL_DIR="$OSSL" \
  -DPARVANE_E2E_LIB="$E2E_LIB" \
  -DPARVANE_PROTOCOL_LIB="$PROTO_LIB" \
  -DCMAKE_BUILD_TYPE=Release
ninja -C "$BUILD"
echo "== готово =="
ls -la "$BUILD"/libparvane_core.a && \
  echo "OK: parvane_core под $ABI собран ($(du -h "$BUILD"/libparvane_core.a | cut -f1))"
