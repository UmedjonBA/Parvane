#!/usr/bin/env bash
# Локальный журнал истории: сообщения (свои + принятые) переживают РЕСТАРТ.
# run1: alice→bob T1. Убиваем. run2 (те же workdir): история воспроизводится,
# alice видит своё T1, bob видит принятое T1 — без сервера (свои sealed на сервер
# как «свои» не попадают, входящие инкрем.курсор не пере-тянет). Плюс новое T2
# после рестарта доставляется. Проверяем и ОТСУТСТВИЕ дублей в журнале.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
SB="${SCRATCH:-/tmp/parvane-hist}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
T1="история1-$(date +%s)"; T2="история2-$(date +%s)"
AH="$A/tdata/parvane-history-alice@local.jsonl"
BH="$B/tdata/parvane-history-bob@local.jsonl"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
info(){ printf '\033[36m--  \033[0m %s\n' "$*"; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

stack_up "$SB"

# ── РАН 1: alice → bob T1 ──
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b1.out" 2>&1 & BP=$!
# Получатель — первым и до готовности: отправка незарегистрированному адресату
# теряется (в v2 — ещё и журнал устройств bob должен существовать)
if is_v2; then READY="v2: готов"; else READY="E2E-устройство готово"; fi
wait_log "$B/log.txt" "$READY" 60 || bad "ран1: bob не поднялся"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="bob@local:$T1" "$BIN" -workdir "$A" >"$SB/a1.out" 2>&1 & AP=$!
for i in $(seq 1 40); do grep -q "(alice@local): $T1" "$B/log.txt" 2>/dev/null && break; sleep 1; done
grep -q "(alice@local): $T1" "$B/log.txt" && ok "ран1: bob получил T1" || bad "ран1: bob НЕ получил T1"
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null; sleep 3

# Журналы записаны в ран1? С P-13 журнал — JSONL построчно зашифрованный
# ("PVSE1:" + base64), текст в нём не ищется: проверяем, что строки есть и все
# запечатаны, а содержимое — по воспроизведению в ран2 (лог клиента).
sealed_ok() { [ -s "$1" ] && ! grep -qav '^PVSE1:' "$1"; }
sealed_ok "$AH" && ok "журнал alice записан и зашифрован" || bad "журнал alice пуст или не зашифрован ($AH)"
sealed_ok "$BH" && ok "журнал bob записан и зашифрован" || bad "журнал bob пуст или не зашифрован ($BH)"
grep -qa "$T1" "$AH" "$BH" 2>/dev/null && bad "T1 лежит в журнале открытым текстом" || ok "T1 в журналах не лежит открыто"
A_CNT1=$(grep -c . "$AH" 2>/dev/null || true)
B_CNT1=$(grep -c . "$BH" 2>/dev/null || true)
info "строк в журналах после ран1: alice=$A_CNT1 bob=$B_CNT1"

# ── РАН 2: ПЕРЕЗАПУСК тех же workdir. alice → bob T2 ──
info "перезапуск (те же workdir)…"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="bob@local:$T2" "$BIN" -workdir "$A" >"$SB/a2.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b2.out" 2>&1 & BP=$!
for i in $(seq 1 40); do grep -q "(alice@local): $T2" "$B/log.txt" 2>/dev/null && break; sleep 1; done
sleep 3
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "── ALICE ран2 ──"; grep -aE "Parvane: (история|сессия поднята|отправлено)" "$A/log.txt" 2>/dev/null | head
echo "── BOB ран2 ──"; grep -aE "Parvane: (история|сессия поднята|входящее)" "$B/log.txt" 2>/dev/null | head
echo "──────────"

grep -qa "история: воспроизведено $A_CNT1 сообщений" "$A/log.txt" && ok "alice воспроизвела журнал при старте ($A_CNT1)" || bad "alice НЕ воспроизвела журнал ($A_CNT1 строк)"
grep -qa "история: воспроизведено $B_CNT1 сообщений" "$B/log.txt" && ok "bob воспроизвёл журнал при старте ($B_CNT1)" || bad "bob НЕ воспроизвёл журнал ($B_CNT1 строк)"
# своё T1 сервер alice не отдаёт — в ран2 оно может прийти только из журнала
grep -qa "своё msg .*(bob@local): $T1" "$A/log.txt" && ok "alice: своё T1 восстановлено из журнала" || bad "alice: своё T1 не восстановлено из журнала"
grep -q "(alice@local): $T2" "$B/log.txt" && ok "ран2: bob получил НОВОЕ T2 (обмен работает после рестарта)" || bad "ран2: bob НЕ получил T2"

# Дублей нет: воспроизведение (live=false) не пере-пишет T1, а T2 допишется
# ровно одной строкой.
A_CNT2=$(grep -c . "$AH" 2>/dev/null || true)
B_CNT2=$(grep -c . "$BH" 2>/dev/null || true)
info "строк в журналах после ран2: alice=$A_CNT2 bob=$B_CNT2"
[ "$A_CNT2" = "$((A_CNT1 + 1))" ] && ok "журнал alice: +1 строка (T2), T1 не задублирован" || bad "alice: журнал $A_CNT1→$A_CNT2 (ожидалось +1)"
[ "$B_CNT2" = "$((B_CNT1 + 1))" ] && ok "журнал bob: +1 строка (T2), T1 не задублирован" || bad "bob: журнал $B_CNT1→$B_CNT2 (ожидалось +1)"
sealed_ok "$AH" && sealed_ok "$BH" && ok "журналы после ран2 целиком зашифрованы" || bad "в журналах есть незашифрованные строки"

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mПЕРСИСТ ИСТОРИИ: OK\033[0m\n' || printf '\033[31mПЕРСИСТ ИСТОРИИ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
