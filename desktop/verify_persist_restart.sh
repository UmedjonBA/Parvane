#!/usr/bin/env bash
# Персист между сессиями: обмен → убить → ПЕРЕЗАПУСК с теми же workdir.
# Инлайн-запуск (как в рабочем verify_phase2), логи ран1/ран2 раздельно.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
SB="${SCRATCH:-/tmp/parvane-restart}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
T1="msg1-$(date +%s)"; T2="msg2-$(date +%s)"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
info(){ printf '\033[36m--  \033[0m %s\n' "$*"; }

stack_up "$SB"

# ── РАН 1 (свежие workdir): alice → bob T1 ──
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="bob@local:$T1" "$BIN" -workdir "$A" >"$SB/a1.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b1.out" 2>&1 & BP=$!
for i in $(seq 1 40); do grep -q "(alice@local): $T1" "$B/log.txt" 2>/dev/null && break; sleep 1; done
grep -q "(alice@local): $T1" "$B/log.txt" && ok "ран1: bob получил $T1" || bad "ран1: bob НЕ получил $T1"
cp "$B/log.txt" "$SB/bob_run1.log" 2>/dev/null; cp "$A/log.txt" "$SB/alice_run1.log" 2>/dev/null
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null; sleep 3

# ── РАН 2: ПЕРЕЗАПУСК тех же workdir. alice → bob T2 ──
info "перезапуск (те же workdir)…"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="bob@local:$T2" "$BIN" -workdir "$A" >"$SB/a2.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b2.out" 2>&1 & BP=$!
for i in $(seq 1 40); do grep -q "(alice@local): $T2" "$B/log.txt" 2>/dev/null && break; sleep 1; done
sleep 2
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "──────── РАН 2 (после рестарта) ────────"
echo "== BOB ран2 log =="; grep -iE "Parvane: (сессия|login|E2E|входящее|НЕ расшифров|получ)" "$B/log.txt" 2>/dev/null | head -12
echo "== ALICE ран2 log =="; grep -iE "Parvane: (сессия|login|E2E|отправлено|autosend)" "$A/log.txt" 2>/dev/null | head -8
echo "== E2E диагностика ALICE ран2 =="; grep "PARVANE-E2E" "$SB/a2.out" 2>/dev/null | tail -8
echo "== E2E диагностика BOB ран2 =="; grep "PARVANE-E2E" "$SB/b2.out" 2>/dev/null | tail -10
echo "──────── анализ ────────"
grep -q "(alice@local): $T2" "$B/log.txt" && ok "E2E ПОСЛЕ рестарта: bob расшифровал НОВОЕ $T2 (сессия/аккаунт сохранены)" || bad "E2E после рестарта НЕ работает (bob не получил $T2)"
grep -q "сессия поднята для alice@local" "$A/log.txt" && ok "alice: self восстановлен после рестарта" || bad "alice: self ПУСТ после рестарта (Parvane-слой не переинициализирован)"
# Хранилище зашифровано (P-13) — искать текст в tdata бессмысленно (найдётся
# разве что в log.txt). Старое T1 после рестарта должно быть показано: из
# журнала или повторным sync — видно по логу ран2.
grep -qa "история: воспроизведено [1-9][0-9]* сообщений" "$B/log.txt" && ok "bob: журнал истории воспроизведён после рестарта" || bad "bob: журнал истории не воспроизведён"
grep -qa "(alice@local): $T1" "$B/log.txt" && ok "старое $T1 показано bob после рестарта" || bad "старое $T1 не показано bob после рестарта"
grep -rqa --exclude='log*.txt' --exclude-dir=DebugLogs "$T1" "$B" && bad "старое $T1 лежит в tdata bob открытым текстом" || ok "старое $T1 в tdata bob открыто не лежит"

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mПЕРСИСТ МЕЖДУ СЕССИЯМИ: OK\033[0m\n' || printf '\033[31mПЕРСИСТ МЕЖДУ СЕССИЯМИ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
