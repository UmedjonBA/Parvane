#!/usr/bin/env bash
# Персист между сессиями: обмен → убить → ПЕРЕЗАПУСК с теми же workdir.
# Инлайн-запуск (как в рабочем verify_phase2), логи ран1/ран2 раздельно.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"; SHARD="$ROOT/../target/debug"
SB="${SCRATCH:-/tmp/parvane-restart}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
T1="msg1-$(date +%s)"; T2="msg2-$(date +%s)"
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; }
info(){ printf '\033[36m--  \033[0m %s\n' "$*"; }

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!; sleep 1
for s in identity messenger; do PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 & done
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 "$SHARD/gateway" >"$SB/gw.log" 2>&1 & GW=$!; sleep 2

# ── РАН 1 (свежие workdir): alice → bob T1 ──
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOSEND="bob@local:$T1" "$BIN" -workdir "$A" >"$SB/a1.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' "$BIN" -workdir "$B" >"$SB/b1.out" 2>&1 & BP=$!
for i in $(seq 1 40); do grep -q "(alice@local): $T1" "$B/log.txt" 2>/dev/null && break; sleep 1; done
grep -q "(alice@local): $T1" "$B/log.txt" && ok "ран1: bob получил $T1" || bad "ран1: bob НЕ получил $T1"
cp "$B/log.txt" "$SB/bob_run1.log" 2>/dev/null; cp "$A/log.txt" "$SB/alice_run1.log" 2>/dev/null
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null; sleep 3

# ── РАН 2: ПЕРЕЗАПУСК тех же workdir. alice → bob T2 ──
info "перезапуск (те же workdir)…"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOSEND="bob@local:$T2" "$BIN" -workdir "$A" >"$SB/a2.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' "$BIN" -workdir "$B" >"$SB/b2.out" 2>&1 & BP=$!
sleep 25
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "──────── РАН 2 (после рестарта) ────────"
echo "== BOB ран2 log =="; grep -iE "Parvane: (сессия|login|E2E|входящее|НЕ расшифров|получ)" "$B/log.txt" 2>/dev/null | head -12
echo "== ALICE ран2 log =="; grep -iE "Parvane: (сессия|login|E2E|отправлено|autosend)" "$A/log.txt" 2>/dev/null | head -8
echo "== E2E диагностика ALICE ран2 =="; grep "PARVANE-E2E" "$SB/a2.out" 2>/dev/null | tail -8
echo "== E2E диагностика BOB ран2 =="; grep "PARVANE-E2E" "$SB/b2.out" 2>/dev/null | tail -10
echo "──────── анализ ────────"
grep -q "(alice@local): $T2" "$B/log.txt" && ok "E2E ПОСЛЕ рестарта: bob расшифровал НОВОЕ $T2 (сессия/аккаунт сохранены)" || bad "E2E после рестарта НЕ работает (bob не получил $T2)"
grep -q "сессия поднята для alice@local" "$A/log.txt" && ok "alice: self восстановлен после рестарта" || bad "alice: self ПУСТ после рестарта (Parvane-слой не переинициализирован)"
if grep -rqa "$T1" "$B" 2>/dev/null; then ok "старое $T1 есть в локальном хранилище bob"; else info "старое $T1 НЕ в tdata bob (история не персистится: инкрем. курсор не пере-запрашивает)"; fi

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null; pkill -9 -x Telegram 2>/dev/null
