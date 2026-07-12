#!/usr/bin/env bash
# Локальный журнал истории: сообщения (свои + принятые) переживают РЕСТАРТ.
# run1: alice→bob T1. Убиваем. run2 (те же workdir): история воспроизводится,
# alice видит своё T1, bob видит принятое T1 — без сервера (свои sealed на сервер
# как «свои» не попадают, входящие инкрем.курсор не пере-тянет). Плюс новое T2
# после рестарта доставляется. Проверяем и ОТСУТСТВИЕ дублей в журнале.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"; SHARD="$ROOT/../target/debug"
SB="${SCRATCH:-/tmp/parvane-hist}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
T1="история1-$(date +%s)"; T2="история2-$(date +%s)"
AH="$A/tdata/parvane-history-alice@local.jsonl"
BH="$B/tdata/parvane-history-bob@local.jsonl"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
info(){ printf '\033[36m--  \033[0m %s\n' "$*"; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!; sleep 1
for s in identity messenger; do PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 & done
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 "$SHARD/gateway" >"$SB/gw.log" 2>&1 & GW=$!; sleep 2

# ── РАН 1: alice → bob T1 ──
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOSEND="bob@local:$T1" "$BIN" -workdir "$A" >"$SB/a1.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' "$BIN" -workdir "$B" >"$SB/b1.out" 2>&1 & BP=$!
for i in $(seq 1 40); do grep -q "(alice@local): $T1" "$B/log.txt" 2>/dev/null && break; sleep 1; done
grep -q "(alice@local): $T1" "$B/log.txt" && ok "ран1: bob получил T1" || bad "ран1: bob НЕ получил T1"
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null; sleep 3

# Журналы записаны в ран1?
grep -qa "$T1" "$AH" 2>/dev/null && ok "журнал alice содержит СВОЁ T1" || bad "нет T1 в журнале alice ($AH)"
grep -qa "$T1" "$BH" 2>/dev/null && ok "журнал bob содержит принятое T1" || bad "нет T1 в журнале bob ($BH)"
A_CNT1=$(grep -c "$T1" "$AH" 2>/dev/null || true)
B_CNT1=$(grep -c "$T1" "$BH" 2>/dev/null || true)
info "T1 в журналах после ран1: alice=$A_CNT1 bob=$B_CNT1"

# ── РАН 2: ПЕРЕЗАПУСК тех же workdir. alice → bob T2 ──
info "перезапуск (те же workdir)…"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOSEND="bob@local:$T2" "$BIN" -workdir "$A" >"$SB/a2.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' "$BIN" -workdir "$B" >"$SB/b2.out" 2>&1 & BP=$!
for i in $(seq 1 40); do grep -q "(alice@local): $T2" "$B/log.txt" 2>/dev/null && break; sleep 1; done
sleep 3
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "── ALICE ран2 ──"; grep -aE "Parvane: (история|сессия поднята|отправлено)" "$A/log.txt" 2>/dev/null | head
echo "── BOB ран2 ──"; grep -aE "Parvane: (история|сессия поднята|входящее)" "$B/log.txt" 2>/dev/null | head
echo "──────────"

grep -qa "история: воспроизведено" "$A/log.txt" && ok "alice воспроизвела журнал при старте" || bad "alice НЕ воспроизвела журнал"
grep -qa "история: воспроизведено" "$B/log.txt" && ok "bob воспроизвёл журнал при старте" || bad "bob НЕ воспроизвёл журнал"
grep -q "(alice@local): $T2" "$B/log.txt" && ok "ран2: bob получил НОВОЕ T2 (обмен работает после рестарта)" || bad "ран2: bob НЕ получил T2"

# Дублей нет: T1 не должен пере-записаться при воспроизведении (live=false).
A_CNT2=$(grep -c "$T1" "$AH" 2>/dev/null || true)
B_CNT2=$(grep -c "$T1" "$BH" 2>/dev/null || true)
info "T1 в журналах после ран2: alice=$A_CNT2 bob=$B_CNT2"
[ "$A_CNT2" = "$A_CNT1" ] && ok "журнал alice не задублировал T1 при воспроизведении" || bad "alice: T1 задублирован ($A_CNT1→$A_CNT2)"
[ "$B_CNT2" = "$B_CNT1" ] && ok "журнал bob не задублировал T1 при воспроизведении" || bad "bob: T1 задублирован ($B_CNT1→$B_CNT2)"
# T2 тоже попал в журналы.
grep -qa "$T2" "$AH" && ok "T2 записан в журнал alice" || bad "T2 нет в журнале alice"
grep -qa "$T2" "$BH" && ok "T2 записан в журнал bob" || bad "T2 нет в журнале bob"

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null; pkill -9 -x Telegram 2>/dev/null
[ "$RC" -eq 0 ] && printf '\033[32mПЕРСИСТ ИСТОРИИ: OK\033[0m\n' || printf '\033[31mПЕРСИСТ ИСТОРИИ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
