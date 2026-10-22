#!/usr/bin/env bash
# NAT-06 (spec 031, T044): реестр мостов медиа звонка (jni/media_slots.h) под ThreadSanitizer на хосте — секунды,
# без NDK и JVM. Отчёт TSan или провал проверки — код возврата не 0.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.build/tsan"; mkdir -p "$OUT"
"${CXX:-clang++}" -std=c++20 -O1 -g -fsanitize=thread -I "$ROOT/jni" "$ROOT/jni/host/tsan_media_slots.cpp" \
  -o "$OUT/tsan_media_slots" -pthread
TSAN_OPTIONS="halt_on_error=1 exitcode=66 ${TSAN_OPTIONS:-}" "$OUT/tsan_media_slots"
