#!/usr/bin/env bash
# Собирает OpenSSL 3.x статически под один Android ABI через NDK.
# Итог: $OUT/<abi>/{include,lib/libssl.a,lib/libcrypto.a}
# Требует: NDK (ANDROID_NDK_HOME), curl, make, perl.
set -Eeuo pipefail
NDK="${ANDROID_NDK_HOME:?задай ANDROID_NDK_HOME}"
ABI="${1:-arm64-v8a}"
API="${ANDROID_API:-24}"
# Последний выпуск ветки 3.5 LTS (C7-7, ревью 7 ноя 2026; был 3.5.1). Эту строку читает tools/check_openssl_version.sh —
# выпуск (tgx_build_upload.sh) не пройдёт со старшей/младшей libcrypto.a. Поднимая версию — пересобрать prebuilt.
VER="${OPENSSL_VER:-3.5.9}"
# SHA-256 архива (совпадает с openssl-3.5.9.tar.gz.sha256 GitHub Releases и openssl.org); для другой версии — OPENSSL_SHA256
case "$VER" in
  3.5.9) OPENSSL_SHA256_DEFAULT=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a ;;
  *) OPENSSL_SHA256_DEFAULT= ;;
esac
OPENSSL_SHA256="${OPENSSL_SHA256:-$OPENSSL_SHA256_DEFAULT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/prebuilt/openssl"
SRC="$ROOT/.build/openssl-$VER"
mkdir -p "$ROOT/.build" "$OUT"

case "$ABI" in
  arm64-v8a)     OSSL_ARCH=android-arm64 ;;
  armeabi-v7a)   OSSL_ARCH=android-arm ;;
  x86_64)        OSSL_ARCH=android-x86_64 ;;
  x86)           OSSL_ARCH=android-x86 ;;
  *) echo "неизвестный ABI: $ABI"; exit 2 ;;
esac

if [ ! -d "$SRC" ]; then
  echo "== качаю OpenSSL $VER =="
  curl -fsSL -o "$ROOT/.build/openssl.tar.gz" \
    "https://github.com/openssl/openssl/releases/download/openssl-$VER/openssl-$VER.tar.gz"
  [ -n "$OPENSSL_SHA256" ] || { echo "нет SHA-256 для OpenSSL $VER: задай OPENSSL_SHA256"; exit 3; }
  echo "$OPENSSL_SHA256  $ROOT/.build/openssl.tar.gz" | sha256sum -c - \
    || { echo "контрольная сумма OpenSSL не совпала"; rm -f "$ROOT/.build/openssl.tar.gz"; exit 3; }
  tar -xzf "$ROOT/.build/openssl.tar.gz" -C "$ROOT/.build"
fi

export ANDROID_NDK_ROOT="$NDK"
TOOLBIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
export PATH="$TOOLBIN:$PATH"

cd "$SRC"
make clean >/dev/null 2>&1 || true
echo "== configure OpenSSL для $ABI ($OSSL_ARCH), API $API =="
./Configure "$OSSL_ARCH" -D__ANDROID_API__="$API" no-shared no-tests no-apps \
  --prefix="$OUT/$ABI"
echo "== make (это небыстро) =="
make -j"$(nproc)" build_libs
make install_dev
echo "== готово: $OUT/$ABI =="
ls -la "$OUT/$ABI/lib" | grep -E "libssl|libcrypto"
