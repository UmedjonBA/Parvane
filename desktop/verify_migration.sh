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
    p=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1)
    if wait_log "$log" "перенос прежнего состояния, шаг $killAt" 180; then
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

for c in ${PV_MIGRATION_CASES:-clean kill-m2 kill-m4}; do
  case "$c" in
    clean) run_case clean "" ;;
    kill-m2) run_case kill-m2 2 ;;
    kill-m4) run_case kill-m4 4 ;;
  esac
done
finish "verify_migration"
