#!/usr/bin/env bash
# Parvane: единый регрессионный прогон ВСЕХ уровней тестов.
# После каждого шага пивота гоняем и текущий, и все предыдущие уровни:
#   1) Rust unit-тесты всех шардов + parvane-types  (cargo test --workspace)
#   2) e2e-контракт бэкенда identity+messenger       (scripts/e2e_smoke.py)
#   3) C++ transport-тесты parvane-core              (parvane_core_tests)
#
# Поднимает свои identity+messenger на временных БД; существующий NATS
# переиспользует, а если его нет — стартует свой и гасит в конце.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.local/bin:$PATH"

NATS_URL="nats://127.0.0.1:4222"
TMP="$(mktemp -d /tmp/parvane-tests.XXXXXX)"
STARTED_NATS=""
PIDS=()
RC=0

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL:\033[0m %s\n' "$*"; RC=1; }

cleanup() {
    for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
    [ -n "$STARTED_NATS" ] && kill "$STARTED_NATS" 2>/dev/null
    rm -rf "$TMP"
}
trap cleanup EXIT

# ── 0. инфраструктура ────────────────────────────────────────────────────────
log "0. NATS"
if ! pgrep -x nats-server >/dev/null; then
    nats-server >"$TMP/nats.log" 2>&1 & STARTED_NATS=$!
    sleep 1
    echo "запущен свой nats-server (pid $STARTED_NATS)"
else
    echo "переиспользую запущенный nats-server"
fi

# ── 1. Rust unit-тесты (все шарды + types) ───────────────────────────────────
log "1. cargo test --workspace"
if cargo test --workspace 2>&1 | tee "$TMP/cargo.log" | grep -E "test result:|error\[|error:" ; then :; fi
if grep -qE "test result: FAILED|error\[|^error:" "$TMP/cargo.log"; then
    fail "cargo test"
else
    echo "cargo: OK"
fi

# ── 2+3. поднять шарды для интеграционных тестов ─────────────────────────────
log "2-3. поднимаю identity + messenger (временные БД)"
PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$TMP/identity.db" \
    ./target/debug/identity >"$TMP/identity.log" 2>&1 & PIDS+=($!)
PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$TMP/messenger.db" \
    ./target/debug/messenger >"$TMP/messenger.log" 2>&1 & PIDS+=($!)
sleep 2
grep -q "NATS подключён" "$TMP/identity.log"  || fail "identity не стартовал"
grep -q "NATS подключён" "$TMP/messenger.log" || fail "messenger не стартовал"

# ── 2. e2e-контракт бэкенда ──────────────────────────────────────────────────
log "2. e2e_smoke.py (контракт identity+messenger)"
if python3 scripts/e2e_smoke.py; then echo "e2e: OK"; else fail "e2e_smoke.py"; fi

# ── 3. C++ transport-тесты parvane-core ──────────────────────────────────────
log "3. parvane-core transport tests (C++)"
PC="$ROOT/desktop/parvane-core"
if [ ! -d "$PC/build" ]; then
    cmake -S "$PC" -B "$PC/build" -G Ninja -DCMAKE_BUILD_TYPE=Release >/dev/null 2>&1 \
        || fail "cmake configure parvane-core"
fi
if cmake --build "$PC/build" -j6 >"$TMP/pc-build.log" 2>&1; then
    if PARVANE_NATS_URL="$NATS_URL" "$PC/build/parvane_core_tests"; then
        echo "transport: OK"
    else
        fail "parvane_core_tests"
    fi
else
    fail "сборка parvane-core (см. $TMP/pc-build.log)"; tail -20 "$TMP/pc-build.log"
fi

# ── итог ─────────────────────────────────────────────────────────────────────
log "ИТОГ"
if [ "$RC" -eq 0 ]; then
    printf '\033[32mВСЕ УРОВНИ ТЕСТОВ ПРОШЛИ\033[0m\n'
else
    printf '\033[31mЕСТЬ ПРОВАЛЫ — см. вывод выше\033[0m\n'
fi
exit "$RC"
