#!/usr/bin/env bash
# C7-7 (ревью 7 ноя 2026): OpenSSL, вшитый статически в libparvane_jni.so, — ровно той версии, что задана в
# build-openssl.sh (одна точка правды: строка VER="${OPENSSL_VER:-X.Y.Z}"). Иначе выпуск с устаревшим OpenSSL прошёл бы
# незаметно: prebuilt/openssl вне git и пересобирается только руками.
#   tools/check_openssl_version.sh <libcrypto.a | libparvane_jni.so | *.apk> …
# Код 0 — во всех файлах найдена строка «OpenSSL <ожидаемая>» и нет других «OpenSSL 3.*»; 1 — нет/не та; 2 — ошибка вызова.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WANT="${PV_OPENSSL_EXPECT:-$(sed -n 's/^VER="\${OPENSSL_VER:-\([0-9.]*\)}"$/\1/p' "$HERE/build-openssl.sh" | head -1)}"
[ -n "$WANT" ] || { echo "openssl: не нашёл ожидаемую версию в build-openssl.sh"; exit 2; }
[ $# -gt 0 ] || { echo "использование: $0 <libcrypto.a|libparvane_jni.so|apk> …"; exit 2; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
rc=0
check() { # $1 — файл, $2 — подпись для вывода
  local got
  got=$(strings -a "$1" | grep -oE '^OpenSSL 3\.[0-9]+\.[0-9]+' | sort -u)
  if [ "$got" = "OpenSSL $WANT" ]; then echo "openssl ok: $2 — $got"
  else echo "openssl FAIL: $2 — найдено «${got:-ничего}», ожидается «OpenSSL $WANT» (android/build-openssl.sh)"; rc=1; fi
}
for f in "$@"; do
  [ -f "$f" ] || { echo "openssl FAIL: нет файла $f"; rc=1; continue; }
  case "$f" in
    *.apk)
      n=0
      for so in $(unzip -Z1 "$f" 'lib/*/libparvane_jni.so' 2>/dev/null); do
        unzip -q -o -d "$TMP" "$f" "$so"; check "$TMP/$so" "$(basename "$f"):$so"; n=$((n+1))
      done
      [ $n -gt 0 ] || { echo "openssl FAIL: в $f нет lib/*/libparvane_jni.so"; rc=1; } ;;
    *) check "$f" "$f" ;;
  esac
done
exit $rc
