#!/usr/bin/env bash
# spec 029, T066/T069: разделы «План», «Знания», «Облако» между двумя устройствами одного аккаунта (домены
# `parvane.planner.v1` и `cloud.v1` шарда domains). alice1 — первое устройство; alice2 привязывается грантом и
# получает ключи контейнеров. Правки — хуками PARVANE_AUTOPLANNER/NOTES/CLOUD (parvane_sections_hooks.cpp),
# проверка — по маркерам снимков «planner: …», «notes: …», «cloud: …» в журналах обоих устройств.
# Бинарь tdesktop — с -DPARVANE_DEV=ON. Данные — выдуманные.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-sections"
stack_start "$SB" PARVANE_DEV=1
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"
TASK="Полить кактус $S"
EVENT="Шахматы $S"
FOLDER="Черновики $S"
NOTE="Идеи $S"
DAY=$(date -d tomorrow +%F)

# ── первое устройство: «План», папка облака, заметка ─────────────────────────
P1=$(start_client "$A1" alice@local "${PV_DEV_OLD[@]}" \
  "PARVANE_AUTOPLANNER=task:$TASK@15,event:$EVENT|$DAY|18:00|19:30@20" \
  "PARVANE_AUTOCLOUD=folder:$FOLDER@25" \
  "PARVANE_AUTONOTES=note:$NOTE|Первая строка заметки@35")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова" || bad "alice1: v2 не поднялся"
wait_log "$L1" "planner: status=ready loaded=1" 90 && ok "alice1: «План» загружен" || bad "alice1: «План» не загрузился"
wait_log "$L1" "autoplanner task $TASK → отправлено" 60 && ok "alice1: задача добавлена" || bad "alice1: задача не добавлена"
wait_log "$L1" "planner: status=ready loaded=1 задачи=\[[^]]*$TASK" 60 && ok "alice1: задача в снимке" \
  || bad "alice1: задачи нет в снимке"
wait_log "$L1" "события=\[[^]]*$EVENT" 60 && ok "alice1: событие в снимке" || bad "alice1: события нет в снимке"
wait_log "$L1" "autocloud folder $FOLDER → ok" 90 && ok "alice1: папка облака создана" || bad "alice1: папка не создана"
wait_log "$L1" "cloud: status=ready корень=\[[^]]*$FOLDER" 60 && ok "alice1: папка в дереве" || bad "alice1: папки нет в дереве"
wait_log "$L1" "autonotes note $NOTE → создана" 90 && ok "alice1: заметка создана" || bad "alice1: заметка не создана"
wait_log "$L1" "notes: status=ready заметки=\[[^]]*$NOTE" 60 && ok "alice1: заметка в списке" || bad "alice1: заметки нет в списке"

# ── второе устройство: привязка, затем те же данные с сервера ────────────────
P2=$(start_client "$A2" alice@local "${PV_DEV_NEW[@]}" \
  "PARVANE_AUTOCLOUD=folder:Входящие $S@60" "PARVANE_AUTONOTES=note:Пусто $S|-@75")
wait_linked "$L2" && ok "alice2 привязана грантом" || bad "alice2 не привязана"
wait_log "$L2" "planner: status=ready loaded=1 задачи=\[[^]]*$TASK" 120 && ok "alice2: задача alice1 пришла" \
  || bad "alice2: задачи alice1 нет"
wait_log "$L2" "события=\[[^]]*$EVENT" 60 && ok "alice2: событие alice1 пришло" || bad "alice2: события alice1 нет"
wait_log "$L2" "cloud: status=ready корень=\[[^]]*$FOLDER" 120 && ok "alice2: папка alice1 в облаке" \
  || bad "alice2: папки alice1 нет"
wait_log "$L2" "notes: status=ready заметки=\[[^]]*$NOTE" 120 && ok "alice2: заметка alice1 в «Знаниях»" \
  || bad "alice2: заметки alice1 нет"
# ── обратно: правка второго устройства доходит до первого (опрос 8–60 с) ─────
wait_log "$L2" "autocloud folder Входящие $S → ok" 120 && ok "alice2: своя папка создана" || bad "alice2: папка не создана"
wait_log "$L1" "cloud: status=ready корень=\[[^]]*Входящие $S" 120 && ok "alice1: папка alice2 пришла" \
  || bad "alice1: папки alice2 нет"
# инварианты: на сервере только шифртекст
grep -qa "$TASK\|$FOLDER\|$NOTE" "$SB"/domains.db* "$SB"/cloud.db* 2>/dev/null && bad "открытый текст разделов на сервере" \
  || ok "на сервере разделы только шифртекстом"
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stack_stop
finish "РАЗДЕЛЫ (План, Знания, Облако) между устройствами"
