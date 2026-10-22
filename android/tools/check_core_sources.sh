#!/usr/bin/env bash
# Сторож (spec 031, FR-003): исходники ядра в android/jni/CMakeLists.txt — ровно те же, что у
# desktop/parvane-core/CMakeLists.txt (библиотека parvane_core). Расхождение — код 1 и разница.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
desk=$(awk '/^add_library\(parvane_core STATIC/{f=1;next} f&&/\)/{print;f=0} f' "$ROOT/desktop/parvane-core/CMakeLists.txt" \
  | grep -o 'src/[a-z0-9_/]*\.cpp' | sort)
andr=$(awk '/^add_library\(parvane_core STATIC/{f=1;next} f&&/\)/{print;f=0} f' "$ROOT/android/jni/CMakeLists.txt" \
  | grep -o 'src/[a-z0-9_/]*\.cpp' | sort)
if [ "$desk" != "$andr" ]; then
  echo "РАСХОЖДЕНИЕ исходников ядра (< desktop, > android):"
  diff <(echo "$desk") <(echo "$andr") || true
  exit 1
fi
echo "OK: исходники ядра совпадают ($(echo "$desk" | wc -l) файлов)"
