#!/usr/bin/env bash
# spec 035 T123 (US1, FR-060…FR-068, contracts/migration.md): разовый перенос desktop. Профиль T006 (наполнение «всё
# понемногу», выдуманные данные) снят НЫНЕШНИМ бинарём выпуска (T008) вместе с базами шардов — копия каталога
# `local-workdirs/spec035/seed-desktop`; выгрузка «до» — `audit-before/desktop/desktop-alice1.jsonl` (T007).
# Новый бинарь на копии профиля: ядро видит прежнее состояние (`parvane-v2-<адрес>/state` без отметки «перенесено»),
# открывает модель с `legacy_present` и переносит его шагами `migrateStep` (слой desktop); выгрузка «после» —
# `auditDump` модели (файл `<PARVANE_AUDIT_DUMP>.model`), сверка — `scripts/migration_audit_diff.py` = 0 потеряно,
# 0 изменено (добавления — только из expected-additions.json). Три прогона на свежей копии: без прерываний, процесс
# убит (`kill -9`) на шаге M2 и на шаге M4 — повторный запуск доводит перенос, сверка снова 0/0. Старые файлы
# остаются на месте (только отметка `engine-migrated`, D2).
# Нужны: бинарь с -DPARVANE_DEV=ON (как у прочих verify_*), шарды backend/target/debug, профиль T006.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
# PV_MIGRATION_BIN — другой бинарь (например, прежний — проверка «падает без правки»)
BIN="${PV_MIGRATION_BIN:-$BIN}"
SEED="${PV_MIGRATION_SEED:-$ROOT/../local-workdirs/spec035/seed-desktop}"
BEFORE="${PV_MIGRATION_BEFORE:-$ROOT/../local-workdirs/spec035/audit-before/desktop/desktop-alice1.jsonl}"
EXPECTED="${PV_MIGRATION_EXPECTED:-$ROOT/../specs/035-protocol-evolution/expected-additions.json}"
DIFF="$ROOT/../scripts/migration_audit_diff.py"
OUT="${PV_MIGRATION_OUT:-$ROOT/../local-workdirs/spec035/verify-migration}"
[ -d "$SEED/alice1/td" ] || { echo "нет профиля T006: $SEED/alice1 (desktop/verify_seed_everything.sh нынешним бинарём)"; exit 2; }
[ -f "$BEFORE" ] || { echo "нет выгрузки «до»: $BEFORE"; exit 2; }
mkdir -p "$OUT"

# Каталог состояния v2 alice в копии профиля (tdata/parvane-v2-<адрес>)
v2dir() { find "$1/td" -maxdepth 3 -type d -name 'parvane-v2-alice*' | head -1; }

run_case() { # run_case <имя> <шаг, на котором убить процесс | "">
  local name="$1" killAt="$2" p log v2
  SB="$(mktemp -d "/tmp/pv-migration-$name-XXXXXX")"
  cp -a "$SEED"/. "$SB"/
  rm -f "$SB"/*.log
  stack_up "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
  wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "$name: identity не поднялся"
  wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "$name: messenger не поднялся"
  sleep 1
  local A="$SB/alice1"
  log="$A/td/log.txt"
  v2="$(v2dir "$A")"
  [ -n "$v2" ] && [ -s "$v2/state" ] && ok "$name: прежнее состояние на месте ($(basename "$v2")/state)" \
    || bad "$name: в профиле T006 нет прежнего состояния"
  [ ! -e "$v2/engine-migrated" ] || bad "$name: профиль уже помечен перенесённым"
  if [ -n "$killAt" ]; then
    # Перенос встаёт сам после фиксации шага точки M$killAt (dev-хук, как web migrationHalt); строки истории —
    # частями по одной, чтобы M2 пришлась посреди строк, а не проскочила за один шаг движка
    p=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 \
      PARVANE_MIGRATION_HALT=$killAt PARVANE_MIGRATION_CHUNK=1)
    if wait_log "$log" "перенос остановлен сценарием в точке M$killAt\b" 180; then
      kill -9 "$p" 2>/dev/null; wait "$p" 2>/dev/null
      ok "$name: процесс убит на шаге M$killAt"
    else
      bad "$name: шаг M$killAt не наступил"; stop_pid "$p"
    fi
    if grep -qa "прежнее состояние перенесено в модель" "$log"; then
      echo "  (перенос успел закончиться до kill — прерывание пришлось на конец)"
    else
      [ ! -e "$v2/engine-migrated" ] && ok "$name: после прерывания отметки «перенесено» нет" \
        || bad "$name: отметка «перенесено» при прерванном переносе"
    fi
  fi
  p=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 \
    "PARVANE_AUDIT_DUMP=$SB/after.jsonl" PARVANE_AUDIT_DUMP_EVERY=20)
  if [ -z "$killAt" ] || ! grep -qa "прежнее состояние перенесено в модель" "$A"/td/log.*.txt 2>/dev/null; then
    wait_log "$log" "прежнее состояние перенесено в модель" 240 && ok "$name: перенос закончен" \
      || bad "$name: перенос не закончился"
  fi
  wait_log "$log" "v2: готов" 120 && ok "$name: сессия на модели готова" || bad "$name: сессия не поднялась"
  wait_log "$log" "audit dump → " 120 && ok "$name: выгрузка снята" || bad "$name: выгрузки нет"
  stop_pid "$p"
  if [ -s "$SB/after.jsonl.model" ]; then
    cp "$SB/after.jsonl.model" "$OUT/desktop-alice1.$name.after.jsonl"
    if python3 "$DIFF" "$BEFORE" "$SB/after.jsonl.model" --expected "$EXPECTED" >"$OUT/$name.diff.txt" 2>&1; then
      ok "$name: сверка «до» ↔ «после» — 0 потеряно, 0 изменено ($(tail -1 "$OUT/$name.diff.txt"))"
    else
      bad "$name: сверка — расхождения (см. $OUT/$name.diff.txt)"; head -20 "$OUT/$name.diff.txt"
    fi
  else
    bad "$name: выгрузки модели нет"
  fi
  [ -s "$v2/state" ] && [ -s "$v2/engine-migrated" ] && ok "$name: старое не тронуто, только помечено «перенесено»" \
    || bad "$name: старое состояние стёрто или не помечено"
  [ -d "$v2/store" ] && ok "$name: хранилище модели — $(basename "$v2")/store" || bad "$name: хранилища модели нет"
  cp "$log" "$OUT/$name.log.txt" 2>/dev/null
  stack_stop
  rm -rf "$SB"
}

# T142 «устройство отсутствовало» (US1 п. 3; conformance README): в профиле T006 у alice два устройства (alice2
# привязана грантом). alice1 переносится новым бинарём, затем вторым запуском — новая папка (личное состояние,
# PARVANE_AUTOFOLDER) и сообщение bob (журнал истории; копия своим устройствам — в инбокс alice2); messenger
# останавливается, на его базе один раз — `messenger --gc-as-of <сейчас + 31 сутки>` (плановые чистки «как через
# месяц», часы стенда не трогаются; инбоксы вычищены), messenger снова поднят; alice2 — выключенная всё это время —
# переносится: `scripts/migration_month_check.py` — у неё потеряно 0 из выгрузки «до», сообщение alice1 есть (из
# журнала истории), строки личного состояния, изменённые alice1, — с тем же дайджестом.
# Проверка «ловит потерю»: PV_MONTH_BREAK=history|state — перед чисткой из базы messenger стираются записи alice1
# после переноса (журнал истории / state.v2) — случай обязан упасть; PV_MONTH_GC=0 — перезапуск без чистки (контроль:
# сообщение тогда доезжает инбоксом).
BEFORE2="${PV_MIGRATION_BEFORE2:-$(dirname "$BEFORE")/desktop-alice2.jsonl}"
MONTH_CHECK="$ROOT/../scripts/migration_month_check.py"
mdb() { # mdb <sql> [параметр…] — запрос к базе messenger стенда
  python3 -c 'import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1], timeout=30)
r = c.execute(sys.argv[2], sys.argv[3:]).fetchall()
c.commit()
print(len(r) if sys.argv[2].lstrip().upper().startswith("DELETE") else r[0][0])' "$SB/messenger.db-v2.db" "$@"
}
wait_model() { # wait_model <файл .model> — свежая выгрузка модели (прежнюю — стереть и дождаться следующей)
  rm -f "$1"
  local n
  for n in $(seq 1 90); do [ -s "$1" ] && return 0; sleep 1; done
  return 1
}
run_month() {
  local p S A1 A2 hist0 st0 out
  SB="$(mktemp -d "/tmp/pv-migration-month-XXXXXX")"
  cp -a "$SEED"/. "$SB"/
  rm -f "$SB"/*.log
  [ -f "$BEFORE2" ] || { bad "month: нет выгрузки «до» alice2: $BEFORE2"; rm -rf "$SB"; return; }
  stack_up "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
  wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "month: messenger не поднялся"
  sleep 1
  A1="$SB/alice1"; A2="$SB/alice2"; S="$(date +%s)"
  # 1. alice1 переносится (как clean)
  p=$(start_client "$A1" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 \
    "PARVANE_AUDIT_DUMP=$SB/a1.jsonl" PARVANE_AUDIT_DUMP_EVERY=15)
  wait_log "$A1/td/log.txt" "прежнее состояние перенесено в модель" 240 && ok "month: alice1 перенесена" \
    || bad "month: перенос alice1 не закончился"
  wait_model "$SB/a1.jsonl.model" || bad "month: выгрузки alice1 нет"
  stop_pid "$p"
  cp "$SB/a1.jsonl.model" "$OUT/desktop-alice1.month.base.jsonl" 2>/dev/null
  if python3 "$DIFF" "$BEFORE" "$SB/a1.jsonl.model" --expected "$EXPECTED" >"$OUT/month-alice1.diff.txt" 2>&1; then
    ok "month: сверка alice1 — 0 потеряно, 0 изменено"
  else
    bad "month: сверка alice1 — расхождения (см. $OUT/month-alice1.diff.txt)"; head -20 "$OUT/month-alice1.diff.txt"
  fi
  hist0=$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_history_log WHERE user = 'alice@local'")
  st0=$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_state_log_v2 WHERE user = 'alice@local'")
  [ "${st0:-0}" -gt 0 ] && ok "month: журнал личного состояния alice перенесён на сервер (state.v2, seq $st0)" \
    || bad "month: state.v2 alice на сервере пуст"
  # 2. alice1: папка и сообщение — уже после переноса
  rm -f "$SB/a1.jsonl.model"
  p=$(start_client "$A1" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 \
    "PARVANE_AUTOFOLDER=Месяц спустя $S:bob@local" \
    "PARVANE_AUTOSEND_V2=bob@local:Выдуманное сообщение после переноса $S" \
    "PARVANE_AUDIT_DUMP=$SB/a1.jsonl" PARVANE_AUDIT_DUMP_EVERY=10)
  wait_log "$A1/td/log.txt" "AUTOFOLDER создал папку" 90 || bad "month: папка alice1 не создана"
  wait_log "$A1/td/log.txt" "autosend-v2 → bob@local: " 150 || bad "month: сообщение alice1 не отправлено"
  local n
  for n in $(seq 1 60); do
    [ "$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_history_log WHERE user = 'alice@local'")" -gt "$hist0" ] \
      && [ "$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_state_log_v2 WHERE user = 'alice@local'")" -gt "$st0" ] && break
    sleep 1
  done
  [ "$n" -lt 60 ] && ok "month: правка alice1 — в журналах истории и личного состояния на сервере" \
    || bad "month: записи alice1 не дошли до журналов сервера"
  sleep 12
  wait_model "$SB/a1.jsonl.model"
  stop_pid "$p"
  cp "$SB/a1.jsonl.model" "$OUT/desktop-alice1.month.changed.jsonl" 2>/dev/null || bad "month: выгрузки alice1 после правки нет"
  if [ -n "${PV_MONTH_BREAK:-}" ]; then
    local t=user_history_log from=$hist0
    [ "$PV_MONTH_BREAK" = state ] && t=user_state_log_v2 from=$st0
    echo "  ПРОВЕРКА НА ПОТЕРЮ: из $t стёрто записей alice после переноса: $(mdb "DELETE FROM $t WHERE user = 'alice@local' AND seq > ? RETURNING seq" "$from")"
  fi
  # 3. «Месяц спустя»: messenger — стоп, плановые чистки как через 31 сутки, старт (часы стенда не трогаются)
  local inbox0 inbox1 mp
  inbox0=$(mdb "SELECT COUNT(*) FROM inbox_log")
  for mp in $(stack_pids messenger); do kill "$mp" 2>/dev/null; done
  for n in $(seq 1 50); do [ -z "$(stack_pids messenger)" ] && break; sleep 0.2; done
  if [ "${PV_MONTH_GC:-1}" != 0 ]; then
    out=$(env PARVANE_DB_PATH="$SB/messenger.db" PARVANE_LOG_LEVEL=warn "$SHARD/messenger" --gc-as-of "$(( $(date +%s) + 31 * 86400 ))" 2>>"$SB/messenger.log")
    inbox1=$(mdb "SELECT COUNT(*) FROM inbox_log")
    echo "  messenger --gc-as-of +31 сутки: $out; инбоксы: было $inbox0, стало $inbox1"
    [ "$inbox1" = 0 ] && [ "$inbox0" -gt 0 ] && ok "month: плановые чистки «как через месяц» вычистили инбоксы" \
      || bad "month: --gc-as-of не вычистил инбоксы ($out)"
  else
    echo "  КОНТРОЛЬ: messenger перезапущен без чистки (инбоксы: $inbox0)"
  fi
  local starts; starts=$(grep -ac "Messenger шард запущен" "$SB/messenger.log")
  shard_start messenger
  for n in $(seq 1 60); do [ "$(grep -ac "Messenger шард запущен" "$SB/messenger.log")" -gt "$starts" ] && break; sleep 1; done
  # 4. alice2 — выключенная всё это время — переносится и видит правку alice1
  p=$(start_client "$A2" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 \
    "PARVANE_AUDIT_DUMP=$SB/a2.jsonl" PARVANE_AUDIT_DUMP_EVERY=20)
  wait_log "$A2/td/log.txt" "прежнее состояние перенесено в модель" 240 && ok "month: alice2 перенесена" \
    || bad "month: перенос alice2 не закончился"
  wait_log "$A2/td/log.txt" "v2: готов" 120 || bad "month: сессия alice2 не поднялась"
  sleep 15
  wait_model "$SB/a2.jsonl.model"
  stop_pid "$p"
  cp "$SB/a2.jsonl.model" "$OUT/desktop-alice2.month.after.jsonl" 2>/dev/null
  # Строки `message` выгрузки desktop — из перенесённой истории (отправленное после переноса в них не попадает):
  # сообщение alice1 — по журналу клиента alice2 (своё, из журнала истории: инбокс вычищен)
  if [ -s "$SB/a2.jsonl.model" ] && python3 "$MONTH_CHECK" --messages-elsewhere "$OUT/desktop-alice1.month.base.jsonl" \
      "$OUT/desktop-alice1.month.changed.jsonl" "$BEFORE2" "$SB/a2.jsonl.model" >"$OUT/month.check.txt" 2>&1; then
    ok "month: alice2 — 0 потеряно, правка личного состояния alice1 на месте ($(tail -1 "$OUT/month.check.txt"))"
  else
    bad "month: alice2 — расхождения (см. $OUT/month.check.txt)"; head -20 "$OUT/month.check.txt"
  fi
  grep -qaE "своё msg .* \(bob@local\): Выдуманное сообщение после переноса $S" "$A2"/td/log*.txt \
    && ok "month: alice2 видит сообщение alice1, отправленное после переноса ($([ "${PV_MONTH_GC:-1}" != 0 ] && echo "журнал истории, инбокс вычищен" || echo "контроль: инбоксом"))" \
    || bad "ПОТЕРЯ: сообщения alice1 после переноса у alice2 нет"
  cp "$A2/td/log.txt" "$OUT/month.alice2.log.txt" 2>/dev/null
  stack_stop
  rm -rf "$SB"
}

for c in ${PV_MIGRATION_CASES:-clean kill-m2 kill-m4 month}; do
  case "$c" in
    clean) run_case clean "" ;;
    kill-m2) run_case kill-m2 2 ;;
    kill-m4) run_case kill-m4 4 ;;
    month) run_month ;;
  esac
done
finish "verify_migration"
