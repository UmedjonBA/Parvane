#!/usr/bin/env bash
# Протокол v2 (spec 007): группы v2 и журнал личного состояния на десктопе.
# Четыре десктопа на v2 (PARVANE_PROTO_V2=1): alice создаёт группу с bob и
# carol (все на v2 → группа v2: подписанный журнал состояния, эпохи ключей),
# пишет; исключает carol (запись журнала → новая эпоха) — carol группу теряет
# и нового сообщения не читает; создаёт ссылку v2
# https://<domain>/join/<link_id>#<seed>, dave вступает по ней и читает
# сообщение bob. Журнал личного состояния (T098): папка alice переживает
# потерю локального файла — возвращается из журнала после рестарта.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
G="G2-$S"
SB="$ROOT/../local-workdirs/verify-protocol-v2-groups"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"; D="$SB/dave"
AL="$A/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"; DL="$D/td/log.txt"
V2=(PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)

# Участники — первыми: их журналы устройств v2 должны существовать до создания.
PB=$(start_client "$B" bob@local "${V2[@]}")
PC=$(start_client "$C" carol@local "${V2[@]}")
PD=$(start_client "$D" dave@local "${V2[@]}")
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
wait_log "$CL" "v2: готов" 90 && ok "carol: v2-сессия готова" || bad "carol: v2 не поднялся"
wait_log "$DL" "v2: готов" 90 && ok "dave: v2-сессия готова" || bad "dave: v2 не поднялся"

PA=$(start_client "$A" alice@local "${V2[@]}" \
  "PARVANE_AUTOGROUP=$G:bob@local,carol@local" \
  "PARVANE_AUTOGROUPSEND=$G:g1-$S" \
  "PARVANE_AUTOADMIN=$G;remove:carol@local" \
  "PARVANE_AUTOGROUPINVITE=$G:create" \
  "PARVANE_AUTOGROUPSEND2=$G:g2-$S" \
  "PARVANE_AUTOFOLDER=Работа-$S:bob@local")
wait_log "$AL" "v2: готов" 90 && ok "alice: v2-сессия готова" || bad "alice: v2 не поднялся"
wait_log "$AL" "группа v2 '$G' создана: v2g:[0-9a-f]{32}" 60 && ok "alice: группа v2 создана (все участники на v2)" \
  || bad "alice: группа v2 не создана"
GID=$(grep -oE "группа v2 '$G' создана: v2g:[0-9a-f]{32}" "$AL" | grep -oE 'v2g:[0-9a-f]{32}' | head -1)
wait_log "$BL" "v2: группа $GID появилась" 60 && ok "bob: группа из проверенного журнала ($GID)" || bad "bob: группа v2 не появилась"
wait_log "$CL" "v2: группа $GID появилась" 60 && ok "carol: группа из журнала" || bad "carol: группа v2 не появилась"
wait_log "$AL" "v2 → $GID msg [0-9a-f-]+ \(text\)" 60 && ok "alice → группа ушло по v2 (конверт эпохи)" \
  || bad "alice → группа не ушло по v2"
wait_log "$BL" "групповое [0-9a-f-]+ в $GID от alice@local: g1-$S" 60 && ok "bob прочитал групповое alice" \
  || bad "bob не получил групповое"
wait_log "$CL" "групповое [0-9a-f-]+ в $GID от alice@local: g1-$S" 60 && ok "carol прочитала групповое alice" \
  || bad "carol не получила групповое"

# Исключение → запись журнала, новая эпоха; carol теряет группу
wait_log "$AL" "админ-действие 'remove' над carol@local в $GID → ok \(v2\)" 60 && ok "alice исключила carol (запись журнала)" \
  || bad "исключение carol не прошло"
wait_log "$AL" "v2: новая эпоха группы [0-9a-f]{32}: [2-9]" 60 && ok "после исключения — новая эпоха" \
  || bad "новой эпохи нет"
wait_log "$CL" "группа $GID снята" 60 && ok "carol: группа снята (groupLeft)" || bad "carol: группа не снята"
wait_log "$BL" "групповое [0-9a-f-]+ в $GID от alice@local: g2-$S" 90 && ok "bob прочитал сообщение новой эпохи" \
  || bad "bob не получил сообщение новой эпохи"
sleep 5
grep -qE "от alice@local: g2-$S" "$CL" && bad "carol прочитала сообщение новой эпохи" \
  || ok "carol сообщение новой эпохи НЕ получила"

# Ссылка v2 → dave вступает
wait_log "$AL" "AUTOGROUPINVITE '$G' create → ok https://[^ ]+/join/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}" 60 \
  && ok "alice: ссылка v2 https://<domain>/join/<link_id>#<seed>" || bad "ссылка v2 не создана"
URL=$(grep -oE "AUTOGROUPINVITE '$G' create → ok https://[^ ]+" "$AL" | head -1 | sed 's/.* ok //')
stop_pid "$PD"
PD=$(start_client "$D" dave@local "${V2[@]}" "PARVANE_AUTOGROUPJOIN=$URL")
wait_log "$DL" "AUTOGROUPJOIN check → $G members=" 90 && ok "dave: превью ссылки v2" || bad "dave: превью ссылки нет"
wait_log "$DL" "AUTOGROUPJOIN join → ok $GID" 90 && ok "dave вступил по ссылке v2" || bad "dave не вступил"
wait_log "$AL" "v2: группа $GID обновлена .*участников 3" 90 && ok "alice видит dave в составе (журнал)" \
  || bad "alice не видит dave"
# bob пишет после вступления dave (новая эпоха с dave раздаётся владельцем)
sleep 12
stop_pid "$PB"
PB=$(start_client "$B" bob@local "${V2[@]}" "PARVANE_AUTOGROUPSEND=$G:g3-$S")
wait_log "$BL" "v2 → $GID msg [0-9a-f-]+ \(text\)" 90 && ok "bob → группа по v2" || bad "bob не отправил в группу"
wait_log "$DL" "групповое [0-9a-f-]+ в $GID от bob@local: g3-$S" 90 && ok "dave прочитал групповое bob" \
  || bad "dave не получил групповое bob"
wait_log "$AL" "групповое [0-9a-f-]+ в $GID от bob@local: g3-$S" 60 && ok "alice прочитала групповое bob" \
  || bad "alice не получила групповое bob"

# Журнал личного состояния: папка — в журнале; локальный файл потерян → вернулась
wait_log "$AL" "журнал личного состояния подключён" 60 && ok "alice: журнал личного состояния подключён" \
  || bad "alice: журнал состояния не подключён"
wait_log "$AL" "AUTOFOLDER создал папку 'Работа-$S'" 60 && ok "alice: папка создана" || bad "alice: папка не создана"
sleep 5
stop_pid "$PA"
rm -f "$A/td/tdata/parvane-folders.json"
PA=$(start_client "$A" alice@local "${V2[@]}")
wait_log "$AL" "журнал состояния → папки \([1-9][0-9]* изменений\)" 90 && ok "папка вернулась из журнала (T098)" \
  || bad "папка из журнала не вернулась"
wait_log "$AL" "v2: группы из кэша: [1-9]" 30 && ok "alice: группа v2 из кэша до подъёма сессии" \
  || bad "alice: кэш групп v2 пуст"

if grep -qE "запись не открыта|ошибка записи|E2E не удался" "$AL" "$BL" "$DL"; then
  bad "в логах есть сбои записей v2"
else
  ok "сбоев записей v2 нет"
fi
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"; stop_pid "$PD"
stack_stop
finish "verify_protocol_v2_groups"
