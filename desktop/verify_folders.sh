#!/usr/bin/env bash
# Папки (chat filters) переживают РЕСТАРТ. run1: alice создаёт папку «Работа» с
# чатом bob (нативный ChatFilters::set) → наш персист parvane-folders.json. run2
# (те же workdir): LoadFolders восстанавливает → лог «папки восстановлены».
# tdesktop создаёт фильтры локально, но хранит только в облаке (MTProto заглушён);
# наш слой добавляет локальный персист.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
SB="${SCRATCH:-/tmp/parvane-folders}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
FF="$A/tdata/parvane-folders.json"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
info(){ printf '\033[36m--  \033[0m %s\n' "$*"; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

stack_up "$SB"

# bob — чтобы peer bob@local резолвился; alice создаёт папку.
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOSEND="alice@local:привет" "$BIN" -workdir "$B" >"$SB/b.out" 2>&1 & BP=$!
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" \
  PARVANE_AUTOFOLDER='Работа:bob@local' "$BIN" -workdir "$A" >"$SB/a1.out" 2>&1 & AP=$!
AL="$A/log.txt"
for i in $(seq 1 25); do grep -qa "AUTOFOLDER создал папку" "$AL" 2>/dev/null && break; sleep 1; done
sleep 2
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null; sleep 1

grep -qa "AUTOFOLDER создал папку 'Работа'" "$AL" && ok "ран1: папка создана (нативный ChatFilters)" || bad "папка не создана"
[ -f "$FF" ] && ok "ран1: персист parvane-folders.json записан" || bad "нет файла персиста ($FF)"
# P-13: персист зашифрован (storecrypt) — имени папки открытым текстом быть
# не должно; что оно сохранено, проверяет восстановление в ран2
grep -qa "Работа" "$FF" 2>/dev/null && bad "имя папки лежит на диске открытым текстом" || ok "ран1: персист зашифрован"
echo "── persist ──"; cat "$FF" 2>/dev/null | head -c 400; echo

# ── РАН 2: перезапуск тех же workdir ──
info "перезапуск…"
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$A" >"$SB/a2.out" 2>&1 & AP=$!
for i in $(seq 1 25); do grep -qa "папки восстановлены" "$AL" 2>/dev/null && break; sleep 1; done
sleep 2
kill "$AP" 2>/dev/null; wait "$AP" 2>/dev/null

echo "── ALICE ран2 ──"; grep -aE "Parvane: (сессия поднята|папки восстановлены)" "$AL" 2>/dev/null | tail -4
grep -qa "папки восстановлены: 1" "$AL" && ok "ран2: папка восстановлена после рестарта" || bad "папка НЕ восстановлена"

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mПАПКИ: OK\033[0m\n' || printf '\033[31mПАПКИ: ПРОВАЛЫ\033[0m\n'
exit "$RC"
