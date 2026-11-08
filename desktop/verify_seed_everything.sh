#!/usr/bin/env bash
# Наполнение «всё понемногу» (spec 035, T006) для эталона «до» разового переноса — desktop, ТОЛЬКО выдуманные данные.
# alice — два устройства (alice2 привязано грантом), bob и carol — собеседники; всё — dev-хуками PARVANE_AUTO*:
# переписка 1:1, правка, удаление «у всех» и «у меня», группа v2 и сообщение в ней, папка, мьют, «непрочитано»,
# быстрая реакция, закреп, архив, блокировка, черновик и отложенное, опрос, «План», заметка «Знаний», папка «Облака».
# Чего у desktop-хуков нет (реакция на сообщение, закреп сообщения, контакт с заметкой, свой набор стикеров, свой GIF,
# совместная папка облака с участником, PIN хранилища — у desktop его нет вовсе) — наполняется web
# (scripts/seed_everything.sh) и в сводке помечено «нет хука».
# Затем SC-009 (T009): alice1 выключена, bob шлёт 50 сообщений, alice1 включается — счётчики сохранений состояния и ack
# на пачку инбокса пишутся в журнал рядом с выгрузкой. В конце — выгрузки auditDump всех профилей (dev-хук
# PARVANE_AUDIT_DUMP, T007) и баз шардов (scripts/migration_audit_server.py --dump).
# Выход: SEED_OUT (по умолчанию local-workdirs/spec035/seed-desktop): профили tdata и базы — там же (каталог стека),
# выгрузки — audit/, итог — seed-summary.txt. Бинарь — с -DPARVANE_DEV=ON (как у прочих verify_*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="${SEED_OUT:-$ROOT/../local-workdirs/spec035/seed-desktop}"
AUD="$SB/audit"
SUMMARY="$SB/seed-summary.txt"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
mkdir -p "$AUD"
: >"$SUMMARY"
note() { echo "$*" | tee -a "$SUMMARY"; }
soft() { # soft <имя> <лог> <regex> [сек] — шаг наполнения: есть маркер — «ok», нет — «нет» (наполнение идёт дальше)
  if wait_log "$2" "$3" "${4:-60}"; then note "ok   $1"; else note "нет  $1 (маркер «$3» не найден)"; fi
}
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"; C="$SB/carol"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
G="Выдуманный клуб $S"
DAY=$(date -d '+1 day' +%F)

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2 готов" || bad "bob: v2 не поднялся"
wait_log "$CL" "v2: готов" 90 && ok "carol: v2 готов" || bad "carol: v2 не поднялся"

# ── переписка 1:1 ─────────────────────────────────────────────────────────────
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOSEND_V2=bob@local:Привет, это выдуманный разговор $S|Сообщение удалить у всех $S|Сообщение удалить у меня $S|Сообщение для правки $S")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2 готов" || bad "alice1: v2 не поднялся"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): Сообщение для правки $S" 120 \
  && ok "bob получил переписку alice1" || bad "bob не получил переписку alice1"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:Ответ bob о вымышленной погоде $S|Bob спрашивает про выдуманный поход $S")
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): Bob спрашивает про выдуманный поход $S" 120 \
  && ok "alice1 получила ответ bob" || bad "alice1 не получила ответ bob"
stop_pid "$PC"
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:Carol передаёт выдуманный привет $S")
wait_log "$L1" "входящее msg [0-9a-f-]+ \(carol@local\): Carol передаёт выдуманный привет $S" 120 \
  && ok "alice1 получила сообщение carol" || bad "alice1 не получила сообщение carol"

# ── всё понемногу на alice1 (хуки после подъёма журнала состояния, ~15 с) ──────
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOSEND_V2=carol@local:Alice отвечает carol $S" \
  "PARVANE_AUTOEDIT=25:Сообщение после правки $S" \
  "PARVANE_AUTOGROUP=$G:bob@local,carol@local" \
  "PARVANE_AUTOGROUPSEND=$G:Первое сообщение выдуманного клуба $S" \
  "PARVANE_AUTOHISTORY=delete-all:bob@local:Сообщение удалить у всех $S@40,delete-me:bob@local:Сообщение удалить у меня $S@44" \
  "PARVANE_AUTOFOLDER=Выдуманная работа:bob@local" \
  "PARVANE_AUTOMUTE=group:$G:50" \
  "PARVANE_AUTOSTATE=unread:carol@local@52,react:🔥@54,pin:bob@local@56" \
  "PARVANE_AUTOSEED=carol@local:58" \
  "PARVANE_AUTOSCHEDULE=bob@local:259200:Отложенное выдуманное напоминание $S" \
  "PARVANE_AUTOPOLL=bob@local:Куда пойдём в выдуманный поход?:в лес,к озеру,в горы" \
  "PARVANE_AUTOPLANNER=task:Выдуманная задача полить кактус $S@30,event:Выдуманная встреча клуба $S|$DAY|18:00|19:00@32" \
  "PARVANE_AUTONOTES=note:Заметка о вымышленном походе $S|Взять фонарик и выдуманную карту@34" \
  "PARVANE_AUTOCLOUD=folder:Выдуманная папка $S@36")
wait_log "$L1" "журнал личного состояния подключён" 90 && ok "alice1: журнал состояния подключён" \
  || bad "alice1: журнал состояния не подключён"
soft "группа v2 создана" "$L1" "v2: группа .* появилась|группа .* обновлена" 60
soft "сообщение в группу" "$BL" "групповое .* от alice@local: Первое сообщение выдуманного клуба $S" 90
soft "«План»: задача и событие" "$L1" "planner: " 60
soft "заметка «Знаний»" "$L1" "notes: " 60
soft "папка «Облака»" "$L1" "cloud: " 60
soft "правка" "$L1" "autoedit → Сообщение после правки $S" 60
soft "мьют группы" "$L1" "automute → " 60
soft "«непрочитано», быстрая реакция, закреп" "$L1" "autostate pin → bob@local" 60
soft "черновик и отложенное (AUTOSEED)" "$L1" "autoseed|черновик" 30
soft "опрос" "$L1" "autopoll → bob@local: Куда пойдём в выдуманный поход" 60
sleep 20
# архив и блокировка — последними (блокировка carol отзывает её доступ к доставке alice)
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOSTATE=archive:carol@local@20,block:carol@local@26")
soft "архив и блокировка" "$L1" "autostate block → carol@local" 90
sleep 15

# ── второе устройство alice ──────────────────────────────────────────────────
# alice2 в сети во время пачки — её счётчики (живые записи инбокса) пишутся строкой выгрузки
P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUDIT_DUMP=$AUD/desktop-alice2.live.jsonl" PARVANE_AUDIT_DUMP_EVERY=20)
wait_log "$L2" "v2: устройство привязано грантом линковки" 180 && ok "alice2 привязана грантом" || bad "alice2 не привязана"
soft "alice2: журнал состояния" "$L2" "журнал личного состояния подключён" 90
sleep 30

# ── SC-009: 50 записей инбокса подряд (alice1 выключена, потом включается) ─────
stop_pid "$P1"
BURST=""
for i in $(seq 1 50); do BURST+="${BURST:+|}Выдуманная пачка $S номер $i"; done
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:$BURST")
wait_log "$L2" "входящее msg [0-9a-f-]+ \(bob@local\): Выдуманная пачка $S номер 50" 180 \
  && ok "bob отправил 50 сообщений (alice2 получила последнее)" || bad "пачка bob не дошла до alice2"
sleep 22
grep -aoE "счётчики SC-009: .*" "$L2" | tail -1 | sed "s/^/alice2 в сети во время пачки из 50: /" | tee -a "$SUMMARY"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUDIT_DUMP=$AUD/desktop-alice1.jsonl" PARVANE_AUDIT_DUMP_EVERY=30)
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): Выдуманная пачка $S номер 50" 180 \
  && ok "alice1 после включения получила все 50" || bad "alice1 не получила пачку"
wait_log "$L1" "audit dump → " 120 && ok "alice1: выгрузка снята" || bad "alice1: выгрузки нет"
grep -aoE "счётчики SC-009: .*" "$L1" | tail -1 | sed "s/^/alice1 после пачки из 50: /" | tee -a "$SUMMARY"
grep -acE "запись инбокса: событий" "$L1" | sed 's/^/alice1: записей инбокса по журналу клиента: /' | tee -a "$SUMMARY"

# ── выгрузки остальных профилей ───────────────────────────────────────────────
dump_profile() { # dump_profile <имя> <workdir> <user> <pid-переменная>
  local who="$1" work="$2" user="$3" pid
  pid=$(start_client "$work" "$user" PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1 \
    "PARVANE_AUDIT_DUMP=$AUD/desktop-$who.jsonl" PARVANE_AUDIT_DUMP_EVERY=30)
  wait_log "$work/td/log.txt" "audit dump → " 150 && ok "$who: выгрузка снята" || bad "$who: выгрузки нет"
  stop_pid "$pid"
}
stop_pid "$P2"; dump_profile alice2 "$A2" alice@local
stop_pid "$PB"; dump_profile bob "$B" bob@local
stop_pid "$PC"; dump_profile carol "$C" carol@local
# alice1 — вторая выгрузка той же сессии (стабильность: без новых событий строки те же)
sleep 32
cp "$AUD/desktop-alice1.jsonl" "$AUD/desktop-alice1.second.jsonl" 2>/dev/null
stop_pid "$P1"
cmp -s "$AUD/desktop-alice1.jsonl" "$AUD/desktop-alice1.second.jsonl" && note "ok   выгрузка alice1 стабильна" \
  || note "нет  выгрузка alice1 изменилась между снятиями"
for f in "$AUD"/desktop-*.jsonl; do note "$(basename "$f"): $(wc -l <"$f") строк, видов $(grep -o '"kind":"[^"]*"' "$f" | sort -u | wc -l)"; done

python3 "$ROOT/../scripts/migration_audit_server.py" --dump "$SB" -o "$AUD/server-desktop.jsonl" \
  && ok "выгрузка баз шардов ($(wc -l <"$AUD/server-desktop.jsonl") таблиц)" || bad "выгрузка баз не снята"
note "нет хука: реакция на сообщение, закреп сообщения, контакт с заметкой, свой набор стикеров, свой GIF, совместная папка облака, PIN хранилища (у desktop нет)"
stack_stop
finish "verify_seed_everything"
