#!/usr/bin/env bash
# Протокол v2 (spec 007, US5/SC-009): линковка второго v2-устройства (LINK-1 v2)
# и журнал личного состояния между устройствами одного аккаунта.
# alice1 — первое v2-устройство (корень, журнал устройств, ключ личного
# состояния). alice2 поднимается на v2: журнал у аккаунта уже есть → своего
# корня НЕ создаёт, публикует оффер; alice1 (PARVANE_AUTOLINK_GRANT=1) выдаёт
# грант с материалом движка (SSK, журнал, ключ доставки, ключ состояния) вторым
# блобом; alice2 записывает себя в журнал устройств и поднимает v2-сессию.
# Затем: сообщение bob по v2 читают оба устройства alice; папка, созданная на
# alice1, появляется на alice2 ≤ 10 с (опрос журнала состояния 8 с).
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-link"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"

PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
G="ГруппаЛинк$S"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOSEND_V2=bob@local:до-линковки-$S" \
  "PARVANE_AUTOGROUP=$G:bob@local" "PARVANE_AUTOGROUPSEND=$G:гр-до-линковки-$S")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова (первое устройство)" || bad "alice1: v2 не поднялся"
wait_log "$L1" "журнал личного состояния подключён" 60 && ok "alice1: журнал личного состояния подключён" \
  || bad "alice1: журнал состояния не подключён"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): до-линковки-$S" 60 && ok "bob получил текст alice1 по v2" \
  || bad "bob не получил текст alice1"
wait_log "$L1" "группа v2 '$G' создана: v2g:[0-9a-f]{32}" 60 && ok "alice1: группа v2 создана" || bad "alice1: группа v2 не создана"
wait_log "$BL" "групповое [0-9a-f-]+ в v2g:[0-9a-f]{32} от alice@local: гр-до-линковки-$S" 60 \
  && ok "bob получил групповое alice1" || bad "bob не получил групповое alice1"

# ── второе устройство: своего корня не создаёт, просит линковку ──────────────
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1)
wait_log "$L2" "v2: у аккаунта уже есть журнал устройств — нужна линковка" 90 \
  && ok "alice2: журнал устройств уже есть — второй корень не создаётся" || bad "alice2: нет отказа «нужна линковка»"
grep -q "v2: устройство создано" "$L2" && bad "alice2 создала собственный корень" || ok "alice2: корень не создан"
wait_log "$L2" "линковка: оффер \(обязательство\) опубликован" 60 && ok "alice2 опубликовала оффер" || bad "alice2 без оффера"
wait_log "$L1" "линковка: грант v2 приложен" 90 && ok "alice1 приложила грант v2" || bad "alice1 не приложила грант v2"
wait_log "$L1" "линковка: грант выдан" 30 && ok "alice1 выдала грант" || bad "грант не выдан"
wait_log "$L2" "линковка: грант v2 получен" 60 && ok "alice2 получила грант v2" || bad "alice2 не получила грант v2"
wait_log "$L2" "v2: устройство привязано грантом линковки" 60 && ok "alice2 записана в журнал устройств" \
  || bad "alice2 не вступила в журнал устройств"
wait_log "$L2" "v2: готов" 90 && ok "alice2: v2-сессия готова" || bad "alice2: v2 не поднялся"
wait_log "$L2" "журнал личного состояния подключён" 60 && ok "alice2: журнал состояния подключён (ключ пришёл грантом)" \
  || bad "alice2: журнал состояния не подключён"
wait_log "$L1" "v2: новое своё устройство" 60 && ok "alice1 увидела новое своё устройство (T119)" \
  || bad "alice1 не увидела новое устройство"

# ── T138 (SC-002, LINK-1 п. 8): история v2-эпохи на новом устройстве ─────────
# «до-линковки» запечатано под одно устройство alice1 — сервер alice2 его не
# отдаст; строка приезжает в экспорте линковки (поле v2History).
wait_log "$L1" "линковка: в экспорт добавлена история v2 \([1-9][0-9]* сообщений\)" 30 \
  && ok "alice1 положила историю v2 в экспорт линковки" || bad "alice1: истории v2 в экспорте нет"
wait_log "$L2" "линковка: история v2 перенесена \([1-9][0-9]* сообщений\)" 60 \
  && ok "alice2 получила историю v2" || bad "alice2: история v2 не перенесена"
wait_log "$L2" "своё msg [0-9a-f-]+ \(bob@local\): до-линковки-$S" 30 \
  && ok "alice2 показывает сообщение, отправленное до линковки" || bad "alice2: сообщения до линковки нет"
[ "$(grep -c "своё msg [0-9a-f-]* (bob@local): до-линковки-$S" "$L2")" = 1 ] \
  && ok "alice2: сообщение истории без дублей" || bad "alice2: сообщение истории задвоилось"
# ── T142: группы v2 на привязанном устройстве ────────────────────────────────
# alice1 пересылает alice2 ключи эпохи и сессии Megolm; alice2 дочитывает журнал
# группы, группа появляется, строка истории группы (ждала в ApplyLinkedV2History) показана.
wait_log "$L1" "v2: группы пересланы новому своему устройству \(записей [1-9][0-9]*\)" 60 \
  && ok "alice1 переслала группы новому устройству" || bad "alice1: группы не пересланы"
wait_log "$L2" "v2: группа v2g:[0-9a-f]{32} появилась" 60 && ok "alice2: группа v2 появилась" || bad "alice2: группа v2 не появилась"
wait_log "$L2" "групповое [0-9a-f-]+ в v2g:[0-9a-f]{32} от alice@local: гр-до-линковки-$S" 120 \
  && ok "alice2 показывает групповое, отправленное до линковки" || bad "alice2: группового сообщения до линковки нет"

# ── сообщение после линковки читают оба устройства alice ─────────────────────
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:после-линковки-$S")
wait_log "$BL" "v2 → alice@local msg [0-9a-f-]+ \(text\)" 90 && ok "bob → alice ушло по v2" || bad "bob → alice не ушло по v2"
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): после-линковки-$S" 60 && ok "alice1 прочитала" || bad "alice1 не прочитала"
wait_log "$L2" "входящее msg [0-9a-f-]+ \(bob@local\): после-линковки-$S" 60 && ok "alice2 прочитала (новое устройство)" \
  || bad "alice2 не прочитала сообщение после линковки"

# T142: новое групповое сообщение участника читает и привязанное устройство
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOGROUPSEND=$G:гр-после-линковки-$S")
wait_log "$L1" "групповое [0-9a-f-]+ в v2g:[0-9a-f]{32} от bob@local: гр-после-линковки-$S" 90 \
  && ok "alice1 прочитала групповое bob" || bad "alice1 не прочитала групповое bob"
wait_log "$L2" "групповое [0-9a-f-]+ в v2g:[0-9a-f]{32} от bob@local: гр-после-линковки-$S" 60 \
  && ok "alice2 (новое устройство) прочитала групповое bob" || bad "alice2 не прочитала групповое bob"

# ── журнал личного состояния между устройствами: папка ≤ 10 с (SC-009) ───────
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOFOLDER=Работа-$S:bob@local")
wait_log "$L1" "AUTOFOLDER создал папку 'Работа-$S'" 90 && ok "alice1: папка создана" || bad "alice1: папка не создана"
wait_log "$L2" "журнал состояния → папки \([1-9][0-9]* изменений\)" 10 && ok "alice2: папка пришла из журнала ≤ 10 с (SC-009)" \
  || bad "alice2: папка не пришла за 10 с"

# ── T160: ссылка-приглашение группы одна на все свои устройства ──────────────
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOGROUPINVITE=$G:create")
wait_log "$L1" "AUTOGROUPINVITE '$G' create → ok" 90 && ok "alice1: ссылка-приглашение создана" \
  || bad "alice1: ссылка-приглашение не создана"
wait_log "$L2" "v2: ссылки-приглашения с других своих устройств: [1-9]" 30 \
  && ok "alice2: ссылка alice1 пришла из журнала личного состояния (T160)" || bad "alice2: ссылка alice1 не пришла"

if grep -qE "запись не открыта|ошибка записи|E2E не удался" "$L1" "$L2" "$BL"; then
  bad "в логах есть сбои записей v2"
else
  ok "сбоев записей v2 нет"
fi
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_link"
