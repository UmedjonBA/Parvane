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
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
info(){ printf '\033[36m--  \033[0m %s\n' "$*"; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

stack_up "$SB"

# ── РАН 1: alice → bob T1 ──
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b1.out" 2>&1 & BP=$!
# Получатель — первым и до готовности: отправка незарегистрированному адресату
# теряется: журнал устройств bob v2 должен уже существовать
wait_log "$B/log.txt" "v2: готов" 90 || bad "ран1: bob не поднялся"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="bob@local:$T1" "$BIN" -workdir "$A" >"$SB/a1.out" 2>&1 & AP=$!
for i in $(seq 1 90); do grep -q "(alice@local): $T1" "$B/log.txt" 2>/dev/null && break; sleep 1; done
grep -q "(alice@local): $T1" "$B/log.txt" && ok "ран1: bob получил T1" || bad "ран1: bob НЕ получил T1"
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null; sleep 3

# С spec 035 T125 строки истории — в модели движка (хранилище parvane-v2-<аккаунт>/store,
# зашифровано): проверяем, что оно есть и T1 в нём не лежит открыто; содержимое — по
# воспроизведению в ран2 (лог клиента).
model_store_sealed "$A/tdata" alice@local "$T1" && ok "модель alice записана, T1 открыто не лежит" || bad "нет модели alice либо T1 лежит открыто"
model_store_sealed "$B/tdata" bob@local "$T1" && ok "модель bob записана, T1 открыто не лежит" || bad "нет модели bob либо T1 лежит открыто"

# ── РАН 2: ПЕРЕЗАПУСК тех же workdir. alice → bob T2 ──
info "перезапуск (те же workdir)…"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="bob@local:$T2" "$BIN" -workdir "$A" >"$SB/a2.out" 2>&1 & AP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b2.out" 2>&1 & BP=$!
for i in $(seq 1 90); do grep -q "(alice@local): $T2" "$B/log.txt" 2>/dev/null && break; sleep 1; done
sleep 3
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

echo "── ALICE ран2 ──"; grep -aE "Parvane: (история|сессия поднята|v2 →)" "$A/log.txt" 2>/dev/null | head
echo "── BOB ран2 ──"; grep -aE "Parvane: (история|сессия поднята|входящее)" "$B/log.txt" 2>/dev/null | head
echo "──────────"

replayed() { grep -aoE "история: воспроизведено [0-9]+ сообщений" "$1" | grep -oE "[0-9]+" | tail -1; }
AR=$(replayed "$A/log.txt"); BR=$(replayed "$B/log.txt")
[ "${AR:-0}" -ge 1 ] && ok "alice воспроизвела историю при старте ($AR)" || bad "alice НЕ воспроизвела историю"
[ "${BR:-0}" -ge 1 ] && ok "bob воспроизвёл историю при старте ($BR)" || bad "bob НЕ воспроизвёл историю"
# своё T1 сервер alice не отдаёт — в ран2 оно может прийти только из журнала
grep -qa "своё msg .*(bob@local): $T1" "$A/log.txt" && ok "alice: своё T1 восстановлено из журнала" || bad "alice: своё T1 не восстановлено из журнала"
grep -q "(alice@local): $T2" "$B/log.txt" && ok "ран2: bob получил НОВОЕ T2 (обмен работает после рестарта)" || bad "ран2: bob НЕ получил T2"

# Дублей нет: T1 в ран2 показан ровно один раз у обоих
[ "$(grep -ac "своё msg .*(bob@local): $T1" "$A/log.txt")" = 1 ] && ok "alice: T1 без дубля" || bad "alice: T1 показан не один раз"
[ "$(grep -ac "(alice@local): $T1" "$B/log.txt")" -le 1 ] && ok "bob: T1 без дубля" || bad "bob: T1 показан больше одного раза"
model_store_sealed "$A/tdata" alice@local "$T1" "$T2" && model_store_sealed "$B/tdata" bob@local "$T1" "$T2" \
  && ok "модели после ран2 без открытого текста" || bad "в моделях лежит открытый текст"

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mПЕРСИСТ ИСТОРИИ: OK\033[0m\n' || printf '\033[31mПЕРСИСТ ИСТОРИИ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
