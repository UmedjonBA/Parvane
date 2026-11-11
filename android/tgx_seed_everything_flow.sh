#!/usr/bin/env bash
# Наполнение «всё понемногу» (spec 035, T006) для эталона «до» разового переноса — Telegram X в эмуляторе, ТОЛЬКО
# выдуманные данные. Свой стек; alice — X (первое устройство) + desktop alice2 (привязан грантом X), bob и carol —
# desktop. X наполняет e2e-командами шва (те же пути, что кнопки X): переписка, удаление «у всех» и «у меня», реакция,
# контакт со своим именем и заметкой, черновик, отложенное, архив, папка, группа, «План», заметка «Знаний», папка и файл
# «Облака». Чего у шва нет (закреп сообщения, совместная папка облака с участником, свой набор стикеров, свой GIF,
# блокировка, PIN хранилища) — наполняется web и desktop, в сводке «нет команды».
# Затем SC-009 (T009): X остановлен, bob шлёт 50 сообщений, X запускается — счётчики сохранений состояния, ack на
# пачку и присоединений потока JNI на событие (`счётчики SC-009:` в logcat). В конце — выгрузка auditDump X (e2e-команда
# audit_dump, T007; файл забирается run-as), desktop-профилей (PARVANE_AUDIT_DUMP) и баз шардов.
# Выход: OUT (по умолчанию local-workdirs/spec035/seed-android): каталог стека с базами и профилями desktop — stack/,
# выгрузки — audit/, сводка — seed-summary.txt. Нужен x64-debug APK X и бинарь desktop с -DPARVANE_DEV=ON.
#   ./tgx_seed_everything_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/../local-workdirs/spec035/seed-android}"; mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
# spec 035 T133 (tgx_migration_flow.sh): наполнение ПРЕЖНИМ выпуском (T008) — APK, шарды, desktop и конфиг NATS
# исходной точки; PV_SEED_SAVE_X=1 — в конце ещё одна выгрузка X и копия каталога приложения (x-data.tar)
[ -n "${PV_SEED_SHARD:-}" ] && SHARD="$PV_SEED_SHARD"
[ -n "${PV_SEED_BIN:-}" ] && BIN="$PV_SEED_BIN"
[ -n "${PV_SEED_APK:-}" ] && tgx_apk() { echo "$PV_SEED_APK"; }
TGX_LOG="$OUT/logcat.txt"
AUD="$OUT/audit"; SUMMARY="$OUT/seed-summary.txt"
SB="$OUT/stack"; stack_start "$SB"; echo "STACK_SB=$SB"
mkdir -p "$AUD"; : >"$SUMMARY"
note() { echo "$*" | tee -a "$SUMMARY"; }
xstep() { # xstep <имя> <json> — команда шва; ответ «→ ok|Ok» — ок, иначе «нет»
  tgx_mark
  if tgx_cmd "$2" && ! tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aqE "e2e-cmd [a-z_]+ → .*(Error|error)"; then note "ok   $1"
  else note "нет  $1"; fi
}
xhas() { # xhas <собеседник> <текст> [сек=120] — текст есть в истории чата X (команда history раз в ~6 с)
  local end=$(( $(date +%s) + ${3:-120} ))
  while [ "$(date +%s)" -lt "$end" ]; do
    tgx_mark; tgx_cmd "{\"op\":\"history\",\"peer\":\"$1\"}" >/dev/null
    tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aF "проверка истории $1:" | grep -aqF "$2" && return 0
    sleep 3
  done
  return 1
}
S=$(date +%s); G="Выдуманный клуб $S"
B="$SB/bob"; C="$SB/carol"; A2="$SB/alice2"; BL="$B/td/log.txt"; CL="$C/td/log.txt"; A2L="$A2/td/log.txt"

BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob (desktop) на v2" || bad "bob не поднялся"
wait_log "$CL" "v2: готов" 90 && ok "carol (desktop) на v2" || bad "carol не поднялась"
emu_boot "$OUT" && ok "эмулятор" || { bad "эмулятор не загрузился"; finish "TGX SEED"; }
tgx_install && ok "APK установлен" || bad "APK не установился"
tgx_fresh alice@local
tgx_logwait "v2: готов" 120 && ok "alice (X) на v2" || bad "сессия v2 X не поднялась"

# ── собеседники пишут первыми (чаты появляются у X) ──────────────────────────
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:Привет от bob, это выдуманный разговор $S|Сообщение bob для реакции $S")
stop_pid "$CP"
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:Carol передаёт выдуманный привет $S")
xhas bob@local "Сообщение bob для реакции $S" 120 && ok "X получил сообщения bob" || bad "X не получил сообщения bob"
xhas carol@local "Carol передаёт выдуманный привет $S" 120 && ok "X получил сообщение carol" || bad "X не получил сообщение carol"

# ── всё понемногу на X ───────────────────────────────────────────────────────
for t in "Ответ alice о вымышленной погоде $S" "Сообщение удалить у всех $S" "Сообщение удалить у меня $S"; do
  xstep "отправка «$t»" "{\"op\":\"send\",\"peer\":\"bob@local\",\"text\":\"$t\"}"
done
wait_log "$BL" "Сообщение удалить у меня $S" 60 && ok "bob получил ответы X" || bad "bob не получил ответы X"
xstep "удаление у всех" "{\"op\":\"delete\",\"peer\":\"bob@local\",\"text\":\"Сообщение удалить у всех $S\",\"everyone\":true}"
xstep "удаление у меня" "{\"op\":\"delete\",\"peer\":\"bob@local\",\"text\":\"Сообщение удалить у меня $S\",\"everyone\":false}"
xstep "реакция" "{\"op\":\"react\",\"peer\":\"bob@local\",\"text\":\"Сообщение bob для реакции $S\",\"emoji\":\"👍\"}"
xstep "контакт с заметкой" "{\"op\":\"contact_set\",\"peer\":\"bob@local\",\"first\":\"Боб\",\"last\":\"Вымышленный\",\"note\":\"Заметка о вымышленном знакомом\"}"
xstep "черновик" "{\"op\":\"draft\",\"peer\":\"carol@local\",\"text\":\"Черновик про вымышленный пикник $S\"}"
xstep "отложенное" "{\"op\":\"schedule\",\"peer\":\"bob@local\",\"text\":\"Отложенное выдуманное напоминание $S\",\"due\":$(( $(date +%s) + 259200 ))}"
xstep "папка" "{\"op\":\"folder\",\"peer\":\"bob@local\",\"title\":\"Выдуманная работа\"}"
xstep "группа" "{\"op\":\"group_create\",\"members\":[\"bob@local\",\"carol@local\"],\"title\":\"$G\"}"
xstep "архив" "{\"op\":\"archive\",\"peer\":\"carol@local\",\"on\":true}"
xstep "раздел «План»" '{"op":"sections","section":"calendar"}'
tgx_logwait "planner: status=ready loaded=1" 300 && note "ok   «План» загружен" || note "нет  «План» не загрузился"
xstep "задача «Плана»" "{\"op\":\"planner_add\",\"text\":\"Полить выдуманный кактус завтра\"}"
xstep "раздел «Знания»" '{"op":"sections","section":"knowledge"}'
xstep "заметка «Знаний»" "{\"op\":\"note_create\",\"title\":\"Заметка о вымышленном походе $S\",\"text\":\"Взять фонарик и выдуманную карту\"}"
xstep "папка «Облака»" "{\"op\":\"cloud_folder\",\"name\":\"Выдуманная папка $S\"}"
tgx_put pv-seed.txt "Выдуманный список: хлеб, сыр"
xstep "файл «Облака»" '{"op":"cloud_upload","path":"/data/local/tmp/pv-seed.txt","name":"список-покупок.txt","mime":"text/plain"}'
# сообщение bob в группу, созданную X (группа приходит bob журналом группы)
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOGROUPSEND=$G:Bob приветствует выдуманный клуб $S")
wait_log "$BL" "групповое .* от bob@local: Bob приветствует выдуманный клуб $S" 120 && note "ok   сообщение bob в группе (отправлено)" \
  || note "нет  сообщение bob в группе не отправлено"; sleep 30
sleep 20

# ── второе устройство alice: desktop, грант с X ──────────────────────────────
tgx_mark
A2P=$(start_client "$A2" alice@local)
tgx_logwait "привязка: запрос от нового устройства" 120 && ok "X: запрос привязки alice2" || bad "X: запроса привязки нет"
tgx_cmd '{"op":"link_grant","peer":"alice@local"}' && ok "X подтвердил привязку" || bad "X не подтвердил"
wait_log "$A2L" "устройство привязано грантом линковки" 120 && ok "alice2 (desktop) привязана" || bad "alice2 не привязана"
sleep 30
stop_pid "$A2P"

# ── SC-009: 50 записей инбокса подряд, X выключен ────────────────────────────
tgx_stop
BURST=""
for i in $(seq 1 50); do BURST+="${BURST:+|}Выдуманная пачка $S номер $i"; done
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:$BURST")
wait_log "$BL" "autosend-v2: alice@local на v2" 120 || bad "bob: пачка не началась"
sleep 75
tgx_start
tgx_logwait "v2: готов" 120 && ok "X снова на v2" || bad "X не поднялся после пачки"
xhas bob@local "Выдуманная пачка $S номер 50" 180 && ok "X получил все 50" || bad "X не получил пачку"
sleep 10
tgx_mark
tgx_cmd '{"op":"audit_dump"}' && ok "X: выгрузка снята" || bad "X: выгрузки нет"
LINE=$(tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aoE "audit dump: -?[0-9]+ строк → [^ ]+" | tail -1)
note "X: $LINE"
grep -aoE "счётчики SC-009: .*" "$TGX_LOG" | tail -1 | sed 's/^/X после пачки из 50: /' | tee -a "$SUMMARY"
DUMP_PATH=$(printf '%s' "$LINE" | sed 's/.*→ //')
if [ -n "$DUMP_PATH" ]; then
  a exec-out run-as "$TGX_PKG" cat "$DUMP_PATH" > "$AUD/android-alice-x.jsonl" 2>/dev/null
  [ -s "$AUD/android-alice-x.jsonl" ] && ok "выгрузка X забрана ($(wc -l <"$AUD/android-alice-x.jsonl") строк)" || bad "выгрузку X забрать не удалось"
fi

# ── выгрузки desktop-профилей и баз ──────────────────────────────────────────
dump_profile() { # dump_profile <имя> <workdir> <user>
  local who="$1" work="$2" user="$3" pid
  pid=$(start_client "$work" "$user" PARVANE_NO_LINK_OFFER=1 "PARVANE_AUDIT_DUMP=$AUD/desktop-$who.jsonl" PARVANE_AUDIT_DUMP_EVERY=30)
  wait_log "$work/td/log.txt" "audit dump → " 150 && ok "$who: выгрузка снята" || bad "$who: выгрузки нет"
  stop_pid "$pid"
}
stop_pid "$BP"; dump_profile bob "$B" bob@local
stop_pid "$CP"; dump_profile carol "$C" carol@local
dump_profile alice2 "$A2" alice@local
if [ "${PV_SEED_SAVE_X:-0}" = 1 ]; then
  # Выгрузка «до» — последней, когда X принял всё от alice2; затем копия каталога приложения (ключ хранилища —
  # в Keystore эмулятора: копия читается только тем же установленным приложением, без pm clear)
  sleep 20
  tgx_mark
  tgx_cmd '{"op":"audit_dump"}' >/dev/null
  LINE=$(tail -n "+$TGX_MARK" "$TGX_LOG" | grep -aoE "audit dump: -?[0-9]+ строк → [^ ]+" | tail -1)
  DUMP_PATH=$(printf '%s' "$LINE" | sed 's/.*→ //')
  [ -n "$DUMP_PATH" ] && a exec-out run-as "$TGX_PKG" cat "$DUMP_PATH" > "$AUD/android-alice-x.final.jsonl" 2>/dev/null
  [ -s "$AUD/android-alice-x.final.jsonl" ] && ok "итоговая выгрузка X ($(wc -l <"$AUD/android-alice-x.final.jsonl") строк)" \
    || bad "итоговой выгрузки X нет"
  tgx_stop
  timeout 120 adb exec-out run-as "$TGX_PKG" sh -c 'tar -cf - $(ls -A | grep -vxE "lib|cache|code_cache")' > "$OUT/x-data.tar" 2>/dev/null
  [ "$(tar -tf "$OUT/x-data.tar" 2>/dev/null | grep -c 'v2-alice')" -gt 0 ] && ok "каталог X сохранён ($(du -h "$OUT/x-data.tar" | cut -f1))" \
    || bad "каталог X не сохранён"
fi
tgx_stop
python3 "$HERE/../scripts/migration_audit_server.py" --dump "$SB" -o "$AUD/server-android.jsonl" \
  && ok "выгрузка баз шардов ($(wc -l <"$AUD/server-android.jsonl") таблиц)" || bad "выгрузка баз не снята"
note "нет команды: закреп сообщения, совместная папка облака с участником, свой набор стикеров, свой GIF, блокировка, PIN хранилища"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
stack_stop
finish "TGX SEED"
