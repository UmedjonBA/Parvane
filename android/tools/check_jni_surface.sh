#!/usr/bin/env bash
# Сторож (spec 031, контракт JNI): каждая `external fun` объектов org.parvane.core.* и TdApi.toString — экспорт
# libparvane_jni.so, и каждый экспорт Java_* — чья-то `external fun` (лишних нет). Аргумент — путь к .so
# (по умолчанию .build/core-x86_64/libparvane_jni.so).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SO="${1:-$ROOT/.build/core-x86_64/libparvane_jni.so}"
NM=/mnt/hdd/ub/android/android-ndk-r27c/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm
want=$(for f in "$ROOT"/libtd/src/main/java/org/parvane/core/*.kt; do
  cls=$(basename "$f" .kt)
  grep -oE 'external fun [A-Za-z0-9_]+' "$f" | awk -v c="$cls" '{print "Java_org_parvane_core_" c "_" $3}'
done; echo Java_org_drinkless_tdlib_TdApi_00024Object_toString; echo Java_org_drinkless_tdlib_TdApi_00024Function_toString) 
want=$(echo "$want" | sort -u)
have=$("$NM" -D --defined-only "$SO" | awk '$3 ~ /^Java_/ {print $3}' | sort -u)
missing=$(comm -23 <(echo "$want") <(echo "$have"))
extra=$(comm -13 <(echo "$want") <(echo "$have"))
rc=0
[ -n "$missing" ] && { echo "НЕТ в .so (external fun без реализации):"; echo "$missing"; rc=1; }
[ -n "$extra" ] && { echo "ЛИШНИЕ экспорты (нет external fun):"; echo "$extra"; rc=1; }
[ $rc = 0 ] && echo "OK: JNI — $(echo "$want" | wc -l) функций, расхождений нет"
exit $rc
