#!/usr/bin/env bash
# spec 033 (HIST-1, HIST-2, READ-2): синхронизация истории между устройствами аккаунта.
# alice1, alice2 (привязана грантом), alice3 (привязывается позже — новое устройство), bob — собеседник.
#  • bob пишет четыре сообщения; на alice1: «удалить у всех» сообщение bob и своё, «только у меня» — ещё одно
#    сообщение bob, прочитать чат;
#  • у bob исчезают оба удалённых «у всех», «только у меня» у него остаётся (FR-015, FR-016);
#  • alice2, бывшая офлайн во время всего, после подключения: удалённого нет, бейдж 0 (US4, READ-2);
#  • alice3 — новое устройство: удалённого нет, бейдж 0, счётчик не раздут переносом (US1, US3, FR-013);
#  • перезапуск alice1 и alice3 — то же (журнал истории на диске, надгробия не воскресают).
# Проверка — строка хука PARVANE_AUTOHISTORYCHECK «проверка истории <чат>: непрочитано N (tdesktop M), тексты […]».
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*). Тяжёлый прогон — по одному (heavy.lock).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-history-sync"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; A3="$SB/alice3"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; L3="$A3/td/log.txt"; BL="$B/td/log.txt"

# Последняя строка проверки истории чата совпала с шаблоном (ждать до n с)
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

ALICE_SEEN="непрочитано 0 \(tdesktop 0\), тексты \[три-$S\|четыре-$S\]$"
BOB_SEEN="тексты \[два-$S\|три-$S\|четыре-$S\]$"
CHECK="PARVANE_AUTOHISTORYCHECK=bob@local@2"

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK" \
  "PARVANE_AUTOSEND_V2=bob@local:знакомство-$S")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова" || bad "alice1: v2 не поднялся"
wait_log "$L1" "журнал истории аккаунта запущен" 60 && ok "alice1: журнал истории запущен" \
  || bad "alice1: журнал истории не запущен"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): знакомство-$S" 60 \
  && ok "bob получил сообщение alice1" || bad "bob не получил сообщение alice1"

# ── второе устройство alice ──────────────────────────────────────────────────
P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK")
wait_log "$L2" "v2: устройство привязано грантом линковки" 150 && ok "alice2 привязана грантом" || bad "alice2 не привязана"
wait_check "$L2" "bob@local" "знакомство-$S" 60 && ok "alice2: своё сообщение alice1 — из журнала истории" \
  || bad "alice2: своего сообщения alice1 нет"

# bob пишет четыре сообщения — их получают оба устройства alice
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOHISTORYCHECK=alice@local@2" \
  "PARVANE_AUTOSEND_V2=alice@local:раз-$S|два-$S|три-$S|четыре-$S")
wait_check "$L1" "bob@local" "непрочитано 4 \(tdesktop 4\), тексты \[знакомство-$S\|раз-$S\|два-$S\|три-$S\|четыре-$S\]$" 90 \
  && ok "alice1: четыре входящих, бейдж 4" || bad "alice1: входящих нет или бейдж не 4"
wait_check "$L2" "bob@local" "непрочитано 4 \(tdesktop 4\)" 60 && ok "alice2: бейдж 4" || bad "alice2: бейдж не 4"

# alice2 офлайн во время удалений и прочтения (US4)
stop_pid "$P2"

# ── на alice1: удалить у всех (чужое и своё), только у меня, прочитать ─────────
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK" \
  "PARVANE_AUTOHISTORY=delete-all:bob@local:раз-$S@14,delete-all:bob@local:знакомство-$S@16,delete-me:bob@local:два-$S@18,read:bob@local@21")
wait_log "$L1" "autohistory delete-all → bob@local" 60 && ok "alice1: удалено у всех" || bad "alice1: удаление у всех не сработало"
wait_log "$L1" "удаление msg [0-9a-f-]+ — у всех" 30 && ok "alice1: чужое в личном чате удалено у всех (права — движок)" \
  || bad "alice1: удаление чужого у всех не разрешено"
wait_log "$L1" "удаление msg [0-9a-f-]+ — только у меня" 30 && ok "alice1: «только у меня»" \
  || bad "alice1: «только у меня» не сработало"
wait_check "$L1" "bob@local" "$ALICE_SEEN" 40 && ok "alice1: удалённого нет, бейдж 0" || bad "alice1: история не та"
wait_check "$BL" "alice@local" "$BOB_SEEN" 40 && ok "bob: удалённое у всех исчезло, «только у меня» осталось" \
  || bad "bob: удаление у всех не дошло или «только у меня» ушло собеседнику"

# ── alice2 подключается после всего: догоняет по журналу истории ─────────────
P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK")
wait_check "$L2" "bob@local" "$ALICE_SEEN" 90 && ok "alice2 (была офлайн): удалённого нет, бейдж 0" \
  || bad "alice2: удалённое вернулось или бейдж не 0"

# ── новое устройство alice3 ──────────────────────────────────────────────────
P3=$(start_client "$A3" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK")
wait_log "$L3" "v2: устройство привязано грантом линковки" 150 && ok "alice3 привязана грантом" || bad "alice3 не привязана"
wait_check "$L3" "bob@local" "$ALICE_SEEN" 90 && ok "alice3 (новое): удалённого нет, бейдж 0" \
  || bad "alice3: удалённое вернулось или бейдж не 0"
if grep -qaE "проверка истории bob@local: непрочитано [0-9]+ \(tdesktop [1-9]" "$L3"; then
  bad "alice3: перенос истории раздувал счётчик tdesktop"
else
  ok "alice3: перенос истории счётчик не раздувал"
fi

# ── перезапуск ───────────────────────────────────────────────────────────────
stop_pid "$P1"; stop_pid "$P3"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK")
P3=$(start_client "$A3" alice@local PARVANE_AUTOLINK_GRANT=1 "$CHECK")
wait_check "$L1" "bob@local" "$ALICE_SEEN" 90 && ok "alice1 после перезапуска: то же" || bad "alice1 после перезапуска: не то"
wait_check "$L3" "bob@local" "$ALICE_SEEN" 90 && ok "alice3 после перезапуска: то же" || bad "alice3 после перезапуска: не то"
wait_log "$L1" "журнал истории: (вход|догон)|журнал истории аккаунта запущен" 10 \
  && ok "alice1: журнал истории поднят из файлов" || bad "alice1: журнал истории не поднят"

grep -qaE "откат сервера" "$L1" "$L2" "$L3" && bad "в логах — откат сервера журнала истории" || ok "отката журнала нет"
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$L3" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$P3"; stop_pid "$PB"
stack_stop
finish "verify_history_sync"
