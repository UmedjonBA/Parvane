#!/usr/bin/env bash
# spec 035 T131 (NAT-06, ORDER-1): очередь событий ядра → Kotlin (jni/event_queue.h) под ThreadSanitizer на хосте —
# секунды, без NDK и JVM. Отчёт TSan или провал проверки — код возврата не 0.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.build/tsan"; mkdir -p "$OUT"
"${CXX:-clang++}" -std=c++20 -O1 -g -fsanitize=thread -I "$ROOT/jni" "$ROOT/jni/host/event_queue_test.cpp" \
  -o "$OUT/event_queue_test" -pthread
TSAN_OPTIONS="halt_on_error=1 exitcode=66 ${TSAN_OPTIONS:-}" "$OUT/event_queue_test"
