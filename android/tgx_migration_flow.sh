#!/usr/bin/env bash
# spec 035 T133 (US1, FR-060…FR-068, contracts/migration.md): разовый перенос android. Профиль T006 («всё понемногу»,
# только выдуманные данные) наполняется ПРЕЖНИМ выпуском (T008: APK, шарды, desktop и конфиг NATS исходной точки
# eefe766d — `local-workdirs/spec035/baseline`) сценарием `tgx_seed_everything_flow.sh`; в конце он снимает выгрузку
# «до» (auditDump прежнего кода) и копию каталога приложения X. Затем ставится НОВЫЙ APK поверх (данные и ключ
# хранилища в Keystore эмулятора остаются — копия каталога читается только этим установленным приложением, поэтому
# наполнение и переносы идут одним прогоном, без pm clear). Три случая на свежей копии каталога X и баз шардов
# (новые шарды на копии баз): без прерываний, процесс убит на шаге M2 и на шаге M4 (dev-хук
# /data/local/tmp/parvane-migration-halt — перенос встаёт после фиксации шага точки, строки истории частями по одной,
# как desktop PARVANE_MIGRATION_HALT/CHUNK) — повторный запуск доводит перенос. Выгрузка «после» — auditDump модели
# движка (e2e-команда model_audit_dump), сверка — scripts/migration_audit_diff.py = 0 потеряно, 0 изменено
# (добавления — только из expected-additions.json). Старые файлы остаются на месте (только отметка engine-migrated, D2).
#   ./tgx_migration_flow.sh            — наполнение + три случая
#   PV_MIGRATION_CASES="plain"          — выбор случаев; PV_MIGRATION_SEED=<каталог> — готовое наполнение (тот же
#                                         эмулятор, приложение не переставлялось и не очищалось после него)
# Нужны: x64-debug APK X нового дерева (tgx_x64.sh), шарды backend/target/debug, артефакты baseline (T008).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
W="$HERE/../local-workdirs/spec035"
BASE="${PV_MIGRATION_BASE:-$W/baseline}"
OLD_APK="${PV_MIGRATION_OLD_APK:-$(ls "$BASE"/android/*-x64-debug.apk 2>/dev/null | head -1)}"
NEW_APK="${PV_MIGRATION_NEW_APK:-$(tgx_apk)}"
OUT="${PV_MIGRATION_OUT:-$W/tgx-migration}"
EXPECTED="${PV_MIGRATION_EXPECTED:-$HERE/../specs/035-protocol-evolution/expected-additions.json}"
DIFF="$HERE/../scripts/migration_audit_diff.py"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
[ -s "$OLD_APK" ] || { echo "нет прежнего APK (T008): $BASE/android/*-x64-debug.apk"; exit 2; }
[ -s "$NEW_APK" ] || { echo "нет нового APK — сначала local-workdirs/spec031/tgx_x64.sh"; exit 2; }
emu_boot "$OUT" && ok "эмулятор" || { bad "эмулятор не загрузился"; finish "TGX MIGRATION"; }

SEED="${PV_MIGRATION_SEED:-}"
if [ -z "$SEED" ]; then
  SEED="$OUT/seed"; rm -rf "$SEED"; mkdir -p "$SEED"
  # Конфиг NATS исходной точки: ACL нынешнего дерева может не знать подписок прежних шардов
  git -C "$HERE/.." show eefe766d:backend/infra/nats/server.prod.conf > "$SEED/nats-old.conf" 2>/dev/null || rm -f "$SEED/nats-old.conf"
  a uninstall "$TGX_PKG" >/dev/null 2>&1 # прежний выпуск — с чистого места (и свой ключ хранилища)
  echo "== наполнение прежним выпуском ($(basename "$OLD_APK")) → $SEED"
  NC=""; [ -s "$SEED/nats-old.conf" ] && NC="$SEED/nats-old.conf"
  # Прежний выпуск шлёт в Hello минорную версию 0 — минимум стека наполнения 0 (стек переноса — как обычно)
  env PV_V2_MIN_MINOR=0 PARVANE_V2_MIN_MINOR=0 PV_SEED_APK="$OLD_APK" PV_SEED_SHARD="$BASE/shards" PV_SEED_BIN="$BASE/desktop/Telegram" PV_SEED_SAVE_X=1 \
    ${NC:+PV_NATS_CONF="$NC"} bash "$HERE/tgx_seed_everything_flow.sh" "$SEED" > "$SEED/seed.log" 2>&1
  grep -aE "FAIL|итоговая выгрузка|каталог X" "$SEED/seed.log" | head -20
fi
BEFORE="$SEED/audit/android-alice-x.final.jsonl"
[ -s "$SEED/x-data.tar" ] && ok "наполнение: копия каталога X ($(du -h "$SEED/x-data.tar" | cut -f1))" || { bad "наполнения нет: $SEED/x-data.tar"; finish "TGX MIGRATION"; }
[ -s "$BEFORE" ] && ok "выгрузка «до» прежним кодом ($(wc -l <"$BEFORE") строк)" || { bad "нет выгрузки «до»: $BEFORE"; finish "TGX MIGRATION"; }
grep -aqF '"kind":"message"' "$BEFORE" && ok "в выгрузке «до» есть строки истории" || bad "в выгрузке «до» нет строк истории"

a install -r -d "$NEW_APK" >/dev/null 2>&1 && ok "новый APK поставлен поверх прежнего" || bad "новый APK не поставился"
a push "$SEED/x-data.tar" /data/local/tmp/pv-x-data.tar >/dev/null 2>&1; a shell chmod 644 /data/local/tmp/pv-x-data.tar
V2="files/tdlib/v2-alice@local"
# Команда в каталоге приложения X. adb склеивает аргументы пробелами без кавычек — строка целиком в одинарных
# кавычках, иначе $(…) и && исполнял внешний шелл гостя (в /, от root), а не run-as
xsh() { a shell "run-as $TGX_PKG sh -c '$1'" 2>/dev/null | tr -d '\r'; }
# Есть ли путь в каталоге X (adb shell сливает stderr в stdout — по выводу ls не судить)
xhas() { [ "$(xsh "[ -e $1 ] && echo есть")" = есть ]; }

run_case() { # run_case <имя> <шаг, на котором убить процесс | "">
  local name="$1" killAt="$2" n path
  echo "== случай $name"
  SB="$(mktemp -d "/tmp/pv-tgx-migration-$name-XXXXXX")"
  cp -a "$SEED/stack"/. "$SB"/
  rm -f "$SB"/*.log; rm -rf "$SB"/bob "$SB"/carol "$SB"/alice2
  stack_up "$SB"
  TGX_LOG="$OUT/$name.logcat.txt"; TGX_LOG_STARTED=""
  tgx_stop
  xsh 'rm -rf $(ls -A | grep -vxE "lib|cache|code_cache") && tar -xf /data/local/tmp/pv-x-data.tar'
  xhas "$V2/state" && ok "$name: прежнее состояние на месте (v2-alice@local/state)" || bad "$name: в копии каталога нет прежнего состояния"
  ! xhas "$V2/engine-migrated" || bad "$name: копия уже помечена перенесённой"
  a reverse "tcp:$PV_GW_WS_PORT" "tcp:$PV_GW_WS_PORT" >/dev/null 2>&1
  tgx_put parvane-gateway "ws://127.0.0.1:$PV_GW_WS_PORT/ws"
  a shell rm -f /data/local/tmp/parvane-e2e-cmd /data/local/tmp/parvane-migration-halt /data/local/tmp/parvane-migration-chunk
  if [ -n "$killAt" ]; then
    tgx_put parvane-migration-halt "$killAt"; tgx_put parvane-migration-chunk 1
    tgx_start
    if tgx_logwait "перенос остановлен сценарием в точке M$killAt\b" 180; then
      a shell am force-stop "$TGX_PKG"; sleep 2
      ok "$name: процесс убит на шаге M$killAt"
    else
      bad "$name: шаг M$killAt не наступил"; tgx_stop
    fi
    a shell rm -f /data/local/tmp/parvane-migration-halt /data/local/tmp/parvane-migration-chunk
    if grep -aq "прежнее состояние перенесено в модель" "$TGX_LOG"; then
      echo "  (перенос успел закончиться до остановки)"
    else
      ! xhas "$V2/engine-migrated" && ok "$name: после прерывания отметки «перенесено» нет" \
        || bad "$name: отметка «перенесено» при прерванном переносе"
    fi
  fi
  tgx_start
  tgx_logwait "прежнее состояние перенесено в модель" 240 && ok "$name: перенос закончен" || bad "$name: перенос не закончился"
  grep -aq "перенос данных: шаг 7 из 7 — готово" "$TGX_LOG" && ok "$name: шов получил ход переноса до конца" \
    || bad "$name: события хода переноса нет"
  tgx_logwait "v2: готов" 120 && ok "$name: сессия на модели готова" || bad "$name: сессия не поднялась"
  sleep 5
  tgx_mark
  tgx_cmd '{"op":"model_audit_dump"}' >/dev/null
  path=$(tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aoE "model audit dump: -?[0-9]+ строк → [^ ]+" | tail -1 | sed 's/.*→ //')
  rm -f "$OUT/$name.after.jsonl"
  [ -n "$path" ] && a exec-out run-as "$TGX_PKG" cat "$path" > "$OUT/$name.after.jsonl" 2>/dev/null
  if [ -s "$OUT/$name.after.jsonl" ]; then
    ok "$name: выгрузка модели снята ($(wc -l <"$OUT/$name.after.jsonl") строк)"
    if python3 "$DIFF" "$BEFORE" "$OUT/$name.after.jsonl" --expected "$EXPECTED" >"$OUT/$name.diff.txt" 2>&1; then
      ok "$name: сверка «до» ↔ «после» — 0 потеряно, 0 изменено ($(tail -1 "$OUT/$name.diff.txt"))"
    else
      bad "$name: сверка — расхождения (см. $OUT/$name.diff.txt)"; head -20 "$OUT/$name.diff.txt"
    fi
  else
    bad "$name: выгрузки модели нет"
  fi
  xhas "$V2/state" && xhas "$V2/engine-migrated" && ok "$name: старое не тронуто, только помечено «перенесено»" \
    || bad "$name: старое состояние стёрто или не помечено"
  xhas "$V2/store" && ok "$name: хранилище модели — v2-alice@local/store" || bad "$name: хранилища модели нет"
  tgx_no_crash
  tgx_stop
  kill "$TGX_LCP" 2>/dev/null
  stack_stop
  rm -rf "$SB"
}

# T142 «устройство отсутствовало» (US1 п. 3; как случай month desktop/verify_migration.sh, роли наоборот): у alice в
# наполнении два устройства — X и alice2 (desktop, привязана грантом X). alice2 переносится новым бинарём и после
# переноса делает правку — папку (личное состояние) и сообщение bob (журнал истории; копия своим — в инбокс X);
# messenger — стоп, `messenger --gc-as-of <сейчас + 31 сутки>` (плановые чистки «как через месяц», инбоксы вычищены),
# старт; X — выключенный всё это время — переносится: у него потеряно 0 из выгрузки «до», правка личного состояния
# alice2 на месте с тем же дайджестом (scripts/migration_month_check.py), сообщение alice2 — в истории X (из журнала
# истории: инбокс вычищен). PV_MONTH_GC=0 — контроль без чистки.
MONTH_CHECK="$HERE/../scripts/migration_month_check.py"
mdb() { # mdb <sql> [параметр…] — запрос к базе messenger стенда
  python3 -c 'import sqlite3, sys
c = sqlite3.connect(sys.argv[1], timeout=30)
print(c.execute(sys.argv[2], sys.argv[3:]).fetchall()[0][0])' "$SB/messenger.db-v2.db" "$@"
}
wait_model() { # wait_model <файл .model> — свежая выгрузка модели desktop (прежнюю — стереть и дождаться следующей)
  rm -f "$1"
  local n
  for n in $(seq 1 90); do [ -s "$1" ] && return 0; sleep 1; done
  return 1
}
run_month() {
  local p S A2 hist0 st0 out n inbox0 inbox1 mp starts path
  echo "== случай month"
  SB="$(mktemp -d "/tmp/pv-tgx-migration-month-XXXXXX")"
  cp -a "$SEED/stack"/. "$SB"/
  rm -f "$SB"/*.log; rm -rf "$SB"/bob "$SB"/carol
  A2="$SB/alice2"; S="$(date +%s)"
  [ -d "$A2" ] || { bad "month: в наполнении нет профиля alice2"; rm -rf "$SB"; return; }
  stack_up "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
  wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "month: messenger не поднялся"
  TGX_LOG="$OUT/month.logcat.txt"; TGX_LOG_STARTED=""
  tgx_stop
  # 1. alice2 (desktop) переносится
  p=$(start_client "$A2" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUDIT_DUMP=$SB/a2.jsonl" PARVANE_AUDIT_DUMP_EVERY=15)
  wait_log "$A2/td/log.txt" "прежнее состояние перенесено в модель" 240 && ok "month: alice2 (desktop) перенесена" \
    || bad "month: перенос alice2 не закончился"
  wait_model "$SB/a2.jsonl.model" || bad "month: выгрузки alice2 нет"
  stop_pid "$p"
  cp "$SB/a2.jsonl.model" "$OUT/month.alice2.base.jsonl" 2>/dev/null
  hist0=$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_history_log WHERE user = 'alice@local'")
  st0=$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_state_log_v2 WHERE user = 'alice@local'")
  [ "${st0:-0}" -gt 0 ] && ok "month: журнал личного состояния alice на сервере (state.v2, seq $st0)" \
    || bad "month: state.v2 alice на сервере пуст"
  # 2. alice2: папка и сообщение — уже после переноса
  p=$(start_client "$A2" alice@local PARVANE_NO_LINK_OFFER=1 \
    "PARVANE_AUTOFOLDER=Месяц спустя $S:bob@local" \
    "PARVANE_AUTOSEND_V2=bob@local:Выдуманное сообщение после переноса $S" \
    "PARVANE_AUDIT_DUMP=$SB/a2.jsonl" PARVANE_AUDIT_DUMP_EVERY=10)
  wait_log "$A2/td/log.txt" "AUTOFOLDER создал папку" 90 || bad "month: папка alice2 не создана"
  wait_log "$A2/td/log.txt" "autosend-v2 → bob@local: " 150 || bad "month: сообщение alice2 не отправлено"
  for n in $(seq 1 60); do
    [ "$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_history_log WHERE user = 'alice@local'")" -gt "$hist0" ] \
      && [ "$(mdb "SELECT COALESCE(MAX(seq), 0) FROM user_state_log_v2 WHERE user = 'alice@local'")" -gt "$st0" ] && break
    sleep 1
  done
  [ "$n" -lt 60 ] && ok "month: правка alice2 — в журналах истории и личного состояния на сервере" \
    || bad "month: записи alice2 не дошли до журналов сервера"
  sleep 12
  wait_model "$SB/a2.jsonl.model"
  stop_pid "$p"
  cp "$SB/a2.jsonl.model" "$OUT/month.alice2.changed.jsonl" 2>/dev/null || bad "month: выгрузки alice2 после правки нет"
  # 3. «Месяц спустя»: messenger — стоп, плановые чистки как через 31 сутки, старт (часы стенда не трогаются)
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
  starts=$(grep -ac "Messenger шард запущен" "$SB/messenger.log")
  shard_start messenger
  for n in $(seq 1 60); do [ "$(grep -ac "Messenger шард запущен" "$SB/messenger.log")" -gt "$starts" ] && break; sleep 1; done
  # 4. X — выключенный всё это время — переносится и видит правку alice2
  xsh 'rm -rf $(ls -A | grep -vxE "lib|cache|code_cache") && tar -xf /data/local/tmp/pv-x-data.tar'
  ! xhas "$V2/engine-migrated" || bad "month: копия X уже помечена перенесённой"
  a reverse "tcp:$PV_GW_WS_PORT" "tcp:$PV_GW_WS_PORT" >/dev/null 2>&1
  tgx_put parvane-gateway "ws://127.0.0.1:$PV_GW_WS_PORT/ws"
  a shell rm -f /data/local/tmp/parvane-e2e-cmd /data/local/tmp/parvane-migration-halt /data/local/tmp/parvane-migration-chunk
  tgx_start
  tgx_logwait "прежнее состояние перенесено в модель" 240 && ok "month: X перенесён" || bad "month: перенос X не закончился"
  tgx_logwait "v2: готов" 120 || bad "month: сессия X не поднялась"
  sleep 15
  tgx_mark
  tgx_cmd '{"op":"model_audit_dump"}' >/dev/null
  path=$(tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aoE "model audit dump: -?[0-9]+ строк → [^ ]+" | tail -1 | sed 's/.*→ //')
  rm -f "$OUT/month.x.after.jsonl"
  [ -n "$path" ] && a exec-out run-as "$TGX_PKG" cat "$path" > "$OUT/month.x.after.jsonl" 2>/dev/null
  if [ -s "$OUT/month.x.after.jsonl" ] && python3 "$MONTH_CHECK" --messages-elsewhere "$OUT/month.alice2.base.jsonl" \
      "$OUT/month.alice2.changed.jsonl" "$BEFORE" "$OUT/month.x.after.jsonl" >"$OUT/month.check.txt" 2>&1; then
    ok "month: X — 0 потеряно, правка личного состояния alice2 на месте ($(tail -1 "$OUT/month.check.txt"))"
  else
    bad "month: X — расхождения (см. $OUT/month.check.txt)"; head -20 "$OUT/month.check.txt"
  fi
  local seen=""
  for n in $(seq 1 20); do
    tgx_mark; tgx_cmd '{"op":"history","peer":"bob@local"}' >/dev/null
    tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aF "проверка истории bob@local:" | grep -aqF "Выдуманное сообщение после переноса $S" && { seen=1; break; }
    sleep 3
  done
  [ -n "$seen" ] && ok "month: X видит сообщение alice2, отправленное после переноса ($([ "${PV_MONTH_GC:-1}" != 0 ] && echo "журнал истории, инбокс вычищен" || echo "контроль: инбоксом"))" \
    || bad "month: сообщения alice2 после переноса у X нет"
  tgx_no_crash
  tgx_stop
  kill "$TGX_LCP" 2>/dev/null
  stack_stop
  rm -rf "$SB"
}

for c in ${PV_MIGRATION_CASES:-plain m2 m4 month}; do
  case "$c" in
    plain) run_case plain "" ;;
    m2) run_case m2 2 ;;
    m4) run_case m4 4 ;;
    month) run_month ;;
  esac
done
a shell rm -f /data/local/tmp/pv-x-data.tar
finish "TGX MIGRATION"
