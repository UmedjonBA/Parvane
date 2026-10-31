#!/usr/bin/env bash
# spec 033 (HIST-1, HIST-2, READ-2): синхронизация истории между устройствами аккаунта — Telegram X в паре с desktop.
# Свой стек. alice1 — desktop (первое устройство, грант без UI), X — второе устройство alice (привязка грантом),
# alice3 — новое desktop-устройство, bob — собеседник (desktop).
#  • bob пишет шесть сообщений — у X бейдж 6;
#  • alice1 офлайн; на X: «удалить у всех» сообщение bob и своё, «только у меня» — ещё одно сообщение bob, прочитать;
#  • bob: удалённые у всех исчезли, «только у меня» осталось (собеседнику ничего не уходит);
#  • alice1 после подключения: удалённого на X нет, бейдж 0 (журнал истории, маркер «прочитано до»);
#  • alice1 удаляет у всех ещё одно сообщение bob — на X оно исчезает (мутация и журнал);
#  • alice3 — новое устройство: удалённого нет, бейдж 0, перенос счётчик не раздувает;
#  • X перезапущен — то же; X начисто (новое устройство, привязка заново) — то же.
# Проверка X — e2e-команда history (строка «проверка истории bob@local: непрочитано N, тексты […]»), desktop — хук
# PARVANE_AUTOHISTORYCHECK. Нужны: APK X (debug, x64) и tdesktop с -DPARVANE_DEV=ON. Тяжёлое — по одному (heavy.lock).
#   ./tgx_history_sync_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-history-sync}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"; S=$(date +%s)
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"; stack_start "$SB"; echo "STACK_SB=$SB"
A1="$SB/alice1"; A3="$SB/alice3"; B="$SB/bob"; L1="$A1/td/log.txt"; L3="$A3/td/log.txt"; BL="$B/td/log.txt"
CHECK="PARVANE_AUTOHISTORYCHECK=bob@local@2"

# Последняя строка проверки истории desktop-клиента совпала с шаблоном (ждать до n с)
wait_check() { # wait_check <лог> <чат> <ERE> [секунд]
  local f="$1" chat="$2" re="$3" n="${4:-40}" line=""
  for _ in $(seq 1 "$n"); do
    line=$(grep -aE "проверка истории $chat:" "$f" 2>/dev/null | tail -1)
    printf '%s' "$line" | grep -qE "$re" && return 0
    sleep 1
  done
  echo "    последняя: ${line:-нет строки проверки}"
  return 1
}
# То же для X: e2e-команда history пишет строку в logcat
x_check() { # x_check <ERE> [попыток по ~3 с]
  local re="$1" n="${2:-30}" line=""
  for _ in $(seq 1 "$n"); do
    tgx_mark
    tgx_cmd '{"op":"history","peer":"bob@local"}' >/dev/null
    line=$(tail -n "+$TGX_MARK" "$TGX_LOG" 2>/dev/null | grep -aE "проверка истории bob@local:" | tail -1)
    printf '%s' "$line" | grep -qE "$re" && return 0
    sleep 2
  done
  echo "    последняя: ${line:-нет строки проверки}"
  return 1
}
x_delete() { # x_delete <текст> <true|false>
  tgx_mark
  tgx_cmd "{\"op\":\"delete\",\"peer\":\"bob@local\",\"text\":\"$1\",\"everyone\":$2}"
}
# X — новое устройство alice: привязка грантом alice1 (хук PARVANE_AUTOLINK_GRANT)
x_link() {
  tgx_fresh alice@local
  tgx_logwait "устройству нужна привязка" 90 && ok "X: аккаунт с журналом — нужна привязка" || bad "X: нет «нужна привязка»"
  tgx_logwait "устройство привязано грантом линковки" 150 && ok "X записан в журнал устройств" || bad "X не вступил в журнал"
  tgx_logwait "журнал истории аккаунта запущен" 90 && ok "X: журнал истории запущен" || bad "X: журнал истории не запущен"
}

ALL="раз-$S|два-$S|три-$S|четыре-$S|пять-$S|шесть-$S"
ALL_RE="раз-$S\\|два-$S\\|три-$S\\|четыре-$S\\|пять-$S\\|шесть-$S"
# После удалений на X: нет «знакомство» (своё у всех), «раз» (bob у всех), «два» (только у меня)
X_SEEN="непрочитано 0, тексты \[три-$S\|четыре-$S\|пять-$S\|шесть-$S\]"
ALICE_SEEN="непрочитано 0 \(tdesktop 0\), тексты \[три-$S\|четыре-$S\|пять-$S\|шесть-$S\]"
BOB_SEEN="тексты \[два-$S\|три-$S\|четыре-$S\|пять-$S\|шесть-$S\]"
# После удаления «три» на alice1
X_SEEN2="непрочитано 0, тексты \[четыре-$S\|пять-$S\|шесть-$S\]"
ALICE_SEEN2="непрочитано 0 \(tdesktop 0\), тексты \[четыре-$S\|пять-$S\|шесть-$S\]"

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2 готов" || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK")
wait_log "$L1" "v2: готов" 90 && ok "alice1 (desktop): первое устройство готово" || bad "alice1: v2 не поднялся"
wait_log "$L1" "журнал истории аккаунта запущен" 60 && ok "alice1: журнал истории запущен" || bad "alice1: журнал истории не запущен"

# ── X — второе устройство alice ──────────────────────────────────────────────
emu_boot "$OUT" || { bad "эмулятор не загрузился"; finish "TGX HISTORY SYNC"; }
tgx_install
x_link
sleep 32 # messenger кэширует устройства получателя 30 с
tgx_mark; tgx_cmd "{\"op\":\"send\",\"peer\":\"bob@local\",\"text\":\"знакомство-$S\"}" && ok "X написал bob" || bad "X не написал bob"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): знакомство-$S" 60 && ok "bob получил сообщение X" || bad "bob не получил сообщение X"
wait_check "$L1" "bob@local" "знакомство-$S" 60 && ok "alice1: своё сообщение с X — из журнала истории" \
  || bad "alice1: сообщения X нет"

# bob пишет шесть сообщений
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOHISTORYCHECK=alice@local@2" \
  "PARVANE_AUTOSEND_V2=alice@local:${ALL}")
x_check "непрочитано 6, тексты \[знакомство-$S\|$ALL_RE\]" 40 && ok "X: шесть входящих, бейдж 6" \
  || bad "X: входящих нет или бейдж не 6"
wait_check "$L1" "bob@local" "непрочитано 6 \(tdesktop 6\)" 60 && ok "alice1: бейдж 6" || bad "alice1: бейдж не 6"

# ── alice1 офлайн; на X: удалить у всех (чужое и своё), только у меня, прочитать ─
stop_pid "$P1"
x_delete "раз-$S" true && ok "X: удалено у всех (сообщение bob)" || bad "X: удаление у всех не выполнено"
tgx_logwait "удаление msg [0-9a-f-]+ — у всех" 20 && ok "X: чужое в личном чате удалено у всех (права — движок)" \
  || bad "X: удаление чужого у всех не разрешено"
x_delete "знакомство-$S" true && ok "X: удалено у всех (своё)" || bad "X: своё не удалено"
x_delete "два-$S" false && ok "X: «только у меня»" || bad "X: «только у меня» не выполнено"
tgx_logwait "удаление msg [0-9a-f-]+ — только у меня" 20 && ok "X: «только у меня» — только журнал" \
  || bad "X: «только у меня» не записано"
tgx_mark; tgx_cmd '{"op":"read","peer":"bob@local"}' && ok "X: чат прочитан" || bad "X: чат не прочитан"
x_check "$X_SEEN" 20 && ok "X: удалённого нет, бейдж 0" || bad "X: история не та"
wait_check "$BL" "alice@local" "$BOB_SEEN" 60 && ok "bob: удалённое у всех исчезло, «только у меня» осталось" \
  || bad "bob: удаление у всех не дошло или «только у меня» ушло собеседнику"

# ── alice1 подключается после всего: догоняет по журналу истории ────────────
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK" \
  "PARVANE_AUTOHISTORY=delete-all:bob@local:три-$S@40")
wait_check "$L1" "bob@local" "$ALICE_SEEN" 35 && ok "alice1 (была офлайн): удалённого на X нет, бейдж 0" \
  || bad "alice1: удалённое вернулось или бейдж не 0"
# alice1 удаляет у всех сообщение bob — X убирает его
wait_log "$L1" "удаление msg [0-9a-f-]+ — у всех" 60 && ok "alice1: «три» удалено у всех" || bad "alice1: удаление не сработало"
x_check "$X_SEEN2" 30 && ok "X: удалённое на alice1 исчезло, бейдж 0" || bad "X: удалённое на alice1 осталось"

# ── новое desktop-устройство alice3 ──────────────────────────────────────────
# Запрос привязки обслуживает устройство, ответившее первым: X тоже своё устройство и забрал бы запрос себе, ожидая
# нажатия «Подтвердить» в шторке, — в сценарии подтверждает автоматически (dev-хук), как desktop с AUTOLINK_GRANT
tgx_put parvane-autolink 1
P3=$(start_client "$A3" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK")
wait_log "$L3" "v2: устройство привязано грантом линковки" 150 && ok "alice3 привязана грантом" || bad "alice3 не привязана"
wait_check "$L3" "bob@local" "$ALICE_SEEN2" 90 && ok "alice3 (новое): удалённого нет, бейдж 0" \
  || bad "alice3: удалённое вернулось или бейдж не 0"
if grep -qaE "проверка истории bob@local: непрочитано [0-9]+ \(tdesktop [1-9]" "$L3"; then
  bad "alice3: перенос истории раздувал счётчик"
else
  ok "alice3: перенос истории счётчик не раздувал"
fi
stop_pid "$P3"

# ── перезапуск X ─────────────────────────────────────────────────────────────
tgx_stop; tgx_start
tgx_logwait "журнал: восстановлено [0-9]+ сообщений" 90 && ok "X: история поднята из журнала на диске" \
  || bad "X: история не поднята после перезапуска"
x_check "$X_SEEN2" 30 && ok "X после перезапуска: удалённого нет, бейдж 0" || bad "X после перезапуска: не то"

# ── X начисто — новое устройство: история из журнала, без раздувания счётчика ─
x_link
x_check "$X_SEEN2" 40 && ok "X (новое устройство): удалённого нет, бейдж 0" || bad "X (новое устройство): не то"
grep -aE "проверка истории bob@local: непрочитано [1-9]" <(tail -n "+$TGX_MARK" "$TGX_LOG") >/dev/null \
  && bad "X (новое): счётчик раздувался" || ok "X (новое): счётчик не раздувался"

grep -qaE "откат сервера" "$TGX_LOG" "$L1" "$L3" && bad "в логах — откат сервера журнала истории" || ok "отката журнала нет"
tgx_no_crash
stop_pid "$P1"; stop_pid "$PB"
kill "$TGX_LCP" 2>/dev/null
stack_stop
finish "TGX HISTORY SYNC"
