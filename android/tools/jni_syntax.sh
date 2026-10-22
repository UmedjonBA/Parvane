#!/usr/bin/env bash
# Синтаксис JNI под NDK без сборки (секунды): clang++ -fsyntax-only для каждого файла android/jni/*.cpp
# (или переданных). Пути — как у jni/CMakeLists.txt.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
NDK="${ANDROID_NDK_HOME:-/mnt/hdd/ub/android/android-ndk-r27c}"
CXX="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/clang++"
files=("$@")
[ ${#files[@]} -eq 0 ] && files=("$ROOT"/jni/*.cpp)
rc=0
for f in "${files[@]}"; do
  "$CXX" --target=aarch64-linux-android24 --sysroot="$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot" \
    -std=c++20 -fsyntax-only -Wall -Wno-unused-function \
    -I "$REPO/desktop/parvane-core/include" -I "$REPO/backend/protocol/ffi/include" \
    -I "$ROOT/third_party" -I "$ROOT/prebuilt/openssl/arm64-v8a/include" -I "$ROOT/jni" "$f" || rc=1
done
exit $rc
