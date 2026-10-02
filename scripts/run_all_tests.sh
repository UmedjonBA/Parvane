#!/usr/bin/env bash
# Parvane: единый регрессионный прогон ВСЕХ уровней тестов.
# После каждого шага пивота гоняем и текущий, и все предыдущие уровни:
#   1) Rust unit-тесты всех шардов + parvane-types  (cargo test --workspace)
#   2) e2e-контракт бэкенда identity+messenger       (scripts/e2e_smoke.py)
#   3) C++ transport-тесты parvane-core              (parvane_core_tests)
#   4) C++ messenger-тесты parvane-core              (parvane_messenger_tests)
#   5) Web lint/unit/build/live browser e2e           (run_web_tests.sh)
#
# Поднимает свои identity+messenger на временных БД; существующий NATS
# переиспользует, а если его нет — стартует свой и гасит в конце.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
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
cargo test --manifest-path "$BACKEND/Cargo.toml" --workspace 2>&1 \
    | tee "$TMP/cargo.log" | grep -E "test result:|error\[|error:" || true
if grep -qE "test result: FAILED|error\[|^error:" "$TMP/cargo.log"; then
    fail "cargo test"
else
    echo "cargo: OK"
fi

# ── 1b. протокол v2: схема и fuzz-регрессия (spec 007, T087/T108) ──────────
log "1b. buf lint + buf breaking (proto/)"
if command -v buf >/dev/null; then
    (cd "$ROOT/proto" && buf lint) || fail "buf lint"
    # Сравнение с последним выпущенным тегом схемы (proto-v*), иначе с master
    PROTO_TAG="$(git -C "$ROOT" tag --list 'proto-v*' --sort=-v:refname | head -1)"
    if [ -n "$PROTO_TAG" ]; then
        AGAINST=".git#tag=$PROTO_TAG,subdir=proto"
    elif git -C "$ROOT" cat-file -e master:proto/buf.yaml 2>/dev/null; then
        AGAINST=".git#branch=master,subdir=proto"
    else
        AGAINST=""
    fi
    if [ -n "$AGAINST" ]; then
        (cd "$ROOT" && buf breaking proto --against "$AGAINST") || fail "buf breaking ($AGAINST)"
    else
        echo "buf breaking: нет выпущенной схемы (ни тега proto-v*, ни proto/ в master) — пропуск"
    fi
else
    fail "buf не найден (см. backend/CLAUDE.md, раздел про схему v2)"
fi

log "1c. fuzz-регрессия движка (frame_decode, envelope_open, group_state, legacy_v1)"
FUZZ_SECS="${PARVANE_FUZZ_SECS:-30}"
if command -v cargo-fuzz >/dev/null && rustup toolchain list | grep -q nightly; then
    for t in frame_decode envelope_open group_state legacy_v1; do
        (cd "$BACKEND/protocol/fuzz" && cargo +nightly fuzz run "$t" -- -max_total_time="$FUZZ_SECS") \
            >"$TMP/fuzz-$t.log" 2>&1 || fail "fuzz $t (лог: fuzz-$t.log)"
    done
else
    # Без nightly — те же цели на детерминированных мутациях векторов
    PARVANE_FUZZ_SECS="$FUZZ_SECS" cargo test --manifest-path "$BACKEND/Cargo.toml" \
        -p parvane-protocol --test fuzz_regression 2>&1 | tee "$TMP/fuzz.log" | grep -E "test result:" || true
    grep -q "test result: ok" "$TMP/fuzz.log" || fail "fuzz_regression"
fi

# ── 2+3. поднять шарды для интеграционных тестов ─────────────────────────────
log "2-3. поднимаю identity + messenger (временные БД)"
PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$TMP/identity.db" \
    PARVANE_DEV=1 "$BACKEND"/target/debug/identity >"$TMP/identity.log" 2>&1 & PIDS+=($!)
PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$TMP/messenger.db" \
    "$BACKEND"/target/debug/messenger >"$TMP/messenger.log" 2>&1 & PIDS+=($!)
PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$TMP/cloud.db" \
    "$BACKEND"/target/debug/cloud >"$TMP/cloud.log" 2>&1 & PIDS+=($!)
PARVANE_NATS_URL="$NATS_URL" PARVANE_DB_PATH="$TMP/call.db" \
    "$BACKEND"/target/debug/call >"$TMP/call.log" 2>&1 & PIDS+=($!)
sleep 2
grep -q "NATS подключён" "$TMP/identity.log"  || fail "identity не стартовал"
grep -q "NATS подключён" "$TMP/messenger.log" || fail "messenger не стартовал"
grep -q "NATS подключён" "$TMP/cloud.log"     || fail "cloud не стартовал"
grep -q "NATS подключён" "$TMP/call.log"      || fail "call не стартовал"

# ── 2. e2e-контракт бэкенда ──────────────────────────────────────────────────
log "2. e2e_smoke.py (контракт identity+messenger)"
if python3 scripts/e2e_smoke.py; then echo "e2e: OK"; else fail "e2e_smoke.py"; fi

log "2b. e2e_cloud.py (контракт cloud: upload/download/list)"
if python3 scripts/e2e_cloud.py; then echo "e2e cloud: OK"; else fail "e2e_cloud.py"; fi

log "2c. e2e_call.py (контракт call: relay сигнала + история)"
if python3 scripts/e2e_call.py; then echo "e2e call: OK"; else fail "e2e_call.py"; fi

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

    # ── 4. C++ messenger-тесты parvane-core (send/sync/edit/read/delivered) ────
    log "4. parvane-core messenger tests (C++)"
    if PARVANE_NATS_URL="$NATS_URL" "$PC/build/parvane_messenger_tests"; then
        echo "messenger: OK"
    else
        fail "parvane_messenger_tests"
    fi

    # ── 5. C++ cloud-тесты parvane-core (upload чанками/download/list) ─────────
    log "5. parvane-core cloud tests (C++)"
    if PARVANE_NATS_URL="$NATS_URL" "$PC/build/parvane_cloud_tests"; then
        echo "cloud: OK"
    else
        fail "parvane_cloud_tests"
    fi

    # ── 6. C++ call-тесты parvane-core (сигналинг + история) ───────────────────
    log "6. parvane-core call tests (C++)"
    if PARVANE_NATS_URL="$NATS_URL" "$PC/build/parvane_call_tests"; then
        echo "call: OK"
    else
        fail "parvane_call_tests"
    fi

    # ── 7. C++ crypto-тесты parvane-core (Ed25519, без бэкенда) ────────────────
    log "7. parvane-core crypto tests (C++)"
    if "$PC/build/parvane_crypto_tests"; then
        echo "crypto: OK"
    else
        fail "parvane_crypto_tests"
    fi

    # ── 8. C++ call_session-тесты (оркестрация звонка + крипто-гейтинг) ─────────
    log "8. parvane-core call_session tests (C++)"
    if "$PC/build/parvane_call_session_tests"; then
        echo "call_session: OK"
    else
        fail "parvane_call_session_tests"
    fi

    # ── 9. C++ call_manager e2e (весь путь сигналинга через живой call-шард) ────
    log "9. parvane-core call_manager tests (C++, live)"
    if PARVANE_NATS_URL="$NATS_URL" "$PC/build/parvane_call_manager_tests"; then
        echo "call_manager: OK"
    else
        fail "parvane_call_manager_tests"
    fi

    # ── 10. C++ group e2e (группы/каналы через живой messenger) ────────────────
    log "10. parvane-core group tests (C++, live)"
    if PARVANE_NATS_URL="$NATS_URL" "$PC/build/parvane_group_tests"; then
        echo "group: OK"
    else
        fail "parvane_group_tests"
    fi

    # ── 11. C++ group_call e2e (групповой звонок mesh через живой call-шард) ────
    log "11. parvane-core group_call tests (C++, live)"
    if PARVANE_NATS_URL="$NATS_URL" "$PC/build/parvane_group_call_tests"; then
        echo "group_call: OK"
    else
        fail "parvane_group_call_tests"
    fi

    # ── 11b. Протокол v2 в parvane-core (spec 007): C ABI движка без стека +
    # v2-сессия против отдельного изолированного стека (свои порты)
    log "11b. parvane-core v2 tests (C++: движок + v2-сессия live)"
    if "$PC/build/parvane_v2_tests" >"$TMP/pc-v2.log" 2>&1; then
        echo "v2 (движок/содержимое): OK"
    else
        fail "parvane_v2_tests"; tail -20 "$TMP/pc-v2.log"
    fi
    if "$PC/build/parvane_protocol_vectors_tests" >"$TMP/pc-vectors.log" 2>&1; then
        echo "protocol_vectors (SEAL-1/GSEAL-1/invite): OK"
    else
        fail "parvane_protocol_vectors_tests"; tail -20 "$TMP/pc-vectors.log"
    fi
    if "$PC/tests/run_v2_session_live.sh" >"$TMP/pc-v2-live.log" 2>&1; then
        echo "v2_session (live): OK"
    else
        fail "parvane_v2_session_tests (лог: pc-v2-live.log)"; tail -30 "$TMP/pc-v2-live.log"
    fi
else
    fail "сборка parvane-core (см. $TMP/pc-build.log)"; tail -20 "$TMP/pc-build.log"
fi

# ── 12. Web quality gate ─────────────────────────────────────────────────────
log "12. Web quality gate"
if scripts/run_web_tests.sh; then
    echo "web: OK"
else
    fail "Web quality gate"
fi

# ── итог ─────────────────────────────────────────────────────────────────────
log "ИТОГ"
if [ "$RC" -eq 0 ]; then
    printf '\033[32mВСЕ УРОВНИ ТЕСТОВ ПРОШЛИ\033[0m\n'
else
    printf '\033[31mЕСТЬ ПРОВАЛЫ — см. вывод выше\033[0m\n'
fi
exit "$RC"
