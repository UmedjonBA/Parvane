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

for c in ${PV_MIGRATION_CASES:-plain m2 m4}; do
  case "$c" in
    plain) run_case plain "" ;;
    m2) run_case m2 2 ;;
    m4) run_case m4 4 ;;
  esac
done
a shell rm -f /data/local/tmp/pv-x-data.tar
finish "TGX MIGRATION"
