#!/usr/bin/env bash
# spec 036 T031 (FR-004/FR-005, SC-003): профиль предыдущей версии → новая версия. Файлы каталога состояния v2
# (id и ключ устройства, корень, копия ключей, ссылки, отметки…) прежняя версия держала файлами storecrypt; новая
# переносит каждый в хранилище движка (`<stateDir>/host`, вид host-file) при первом обращении: отметка и данные
# одной пачкой, сверка чтением, прежний файл → `.migrated`. Проверяется, что после переноса это то же устройство
# (без новой привязки), переписка и личное состояние на месте, повторный запуск ничего не переносит заново, а
# прервать перенос нельзя так, чтобы потерять данные (прежние файлы не трогаются до сверки — ctest engine_store).
# «Предыдущая версия» — тот же бинарь с dev-хуком PARVANE_STORE_LEGACY=1 (только прежние файлы storecrypt).
# Бинарь tdesktop — с -DPARVANE_DEV=ON. Данные — выдуманные.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-store-migration"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A="$SB/alice"; B="$SB/bob"
AL="$A/td/log.txt"; BL="$B/td/log.txt"
STATE="$A/td/tdata/parvane-v2-alice@local"

# ── «предыдущая версия»: переписка, папка, файлы — storecrypt ────────────────
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2 готова" || bad "bob: v2 не поднялась"
PA=$(start_client "$A" alice@local PARVANE_STORE_LEGACY=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=bob@local:до-переноса-$S" "PARVANE_AUTOFOLDER=Дача-$S:bob@local")
wait_log "$AL" "v2: готов" 90 && ok "alice (прежняя версия): v2 готова" || bad "alice: v2 не поднялась"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): до-переноса-$S" 60 && ok "bob получил текст alice" \
  || bad "bob не получил текст alice"
wait_log "$AL" "AUTOFOLDER создал папку 'Дача-$S'" 60 && ok "alice: папка создана" || bad "alice: папка не создана"
sleep 4
stop_pid "$PA"
grep -qa "перенесён в хранилище движка" "$AL" && bad "прежняя версия переносила файлы" || ok "прежняя версия — без переноса"
[ -e "$STATE/device" ] && [ -e "$STATE/key" ] && [ ! -e "$STATE/host" ] \
  && ok "профиль прежней версии: файлы storecrypt, хранилища файлов нет" || bad "профиль не похож на прежнюю версию"
# spec 036 T031: файлы tdata/parvane-* вне каталога состояния — тоже прежние файлы storecrypt
TD="$A/td/tdata"
[ -e "$TD/parvane-session.txt" ] && [ -e "$TD/parvane-v2-ids.txt" ] && [ ! -e "$TD/parvane-host" ] \
  && ok "tdata прежней версии: файлы storecrypt (учётные данные, журнал id), хранилища tdata нет" \
  || bad "tdata не похож на прежнюю версию"

# ── новая версия: перенос при первом запуске ──────────────────────────────────
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=bob@local:после-переноса-$S")
wait_log "$AL" "хранилище: файл device перенесён в хранилище движка" 60 && ok "id устройства перенесён" \
  || bad "id устройства не перенесён"
wait_log "$AL" "хранилище: файл key перенесён в хранилище движка" 60 && ok "ключ устройства модели перенесён" \
  || bad "ключ устройства модели не перенесён"
wait_log "$AL" "v2: готов" 90 && ok "alice (новая версия): v2 готова" || bad "alice: v2 не поднялась после переноса"
grep -qaE "нужна линковка этого устройства|нужна привязка" "$AL" && bad "после переноса — новое устройство" \
  || ok "то же устройство — без привязки заново"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): после-переноса-$S" 60 && ok "bob получил текст alice после переноса" \
  || bad "bob не получил текст после переноса — ключи устройства потеряны"
wait_log "$AL" "история: воспроизведено [1-9][0-9]* сообщений" 30 \
  && ok "история до переноса на месте" || bad "истории до переноса нет"
wait_log "$AL" "папки восстановлены: [1-9]|(журнал состояния|личное состояние при запуске) → папки" 30 \
  && ok "папка на месте" || bad "папки нет"
wait_log "$AL" "хранилище tdata: файл перенесён в хранилище движка: parvane-session.txt" 30 \
  && ok "учётные данные tdata перенесены" || bad "учётные данные tdata не перенесены"
wait_log "$AL" "хранилище tdata: файл перенесён в хранилище движка: parvane-v2-ids.txt" 60 \
  && ok "журнал id (дозапись строками) перенесён" || bad "журнал id не перенесён"
grep -qa "не перенесён\|в карантине хранилища\|испорчен — в карантине" "$AL" && bad "есть непереносимые файлы" || ok "все файлы перенесены без карантина"
[ -e "$TD/parvane-session.txt.migrated" ] && [ ! -e "$TD/parvane-session.txt" ] && [ -d "$TD/parvane-host" ] \
  && [ -e "$TD/parvane-v2-ids.txt.migrated" ] && [ -d "$TD/parvane-host-account" ] \
  && ok "tdata: прежние файлы — .migrated, записи — в хранилищах parvane-host*" || bad "раскладка tdata после переноса не та"
[ -e "$STATE/device.migrated" ] && [ ! -e "$STATE/device" ] && [ -d "$STATE/host" ] \
  && ok "прежние файлы — .migrated, данные — в хранилище движка" || bad "раскладка после переноса не та"
grep -rqa --exclude='log*.txt' --exclude-dir=DebugLogs "после-переноса-$S" "$A/td/tdata" \
  && bad "текст лежит в tdata открытым" || ok "в tdata открытого текста нет"
sleep 3
stop_pid "$PA"

# ── повторный запуск: перенос не повторяется, всё на месте ───────────────────
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$AL" "v2: готов" 90 && ok "повторный запуск: v2 готова" || bad "повторный запуск: v2 не поднялась"
grep -qa "перенесён в хранилище движка" "$AL" && bad "перенос повторился" || ok "перенос не повторяется"

grep -qiE "Fatal|Unexpected in " "$AL" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"
stack_stop
finish "verify_store_migration"
