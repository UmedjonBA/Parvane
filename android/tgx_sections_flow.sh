#!/usr/bin/env bash
# Разделы «План», «Знания», «Облако» на X (spec 031, T069; DOMAIN-1/2, CLOUD-1) после tgx_protocol_link_flow.sh:
# X — второе устройство alice (привязано грантом), alice-desktop — первое. Desktop правит хуками
# PARVANE_AUTOPLANNER/NOTES/CLOUD → X видит в снимках хаба разделов ядра; X правит теми же вызовами ядра, что
# экраны (e2e-хук: planner_add, note_create, cloud_folder) → desktop видит. На сервере — только шифртекст.
#   ./tgx_sections_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-sections}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); A="$SB/alice"; AL="$A/td/log.txt"
S=$(date +%s); DAY=$(date -d tomorrow +%F)
W=$(printf %s "$S" | md5sum | tr -d "0-9 -" | cut -c1-6) # без цифр: ввод текстом не примет их за время/количество
TASK="Полить кактус $S"; EVENT="Шахматы $S"; FOLDER="Черновики $S"; NOTE="Идеи $S"
XTASK="Купить хлеб $W"; XNOTE="Заметка с телефона $S"; XFOLDER="С телефона $S"
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"
tgx_cmd '{"op":"sections","section":"calendar"}' || bad "X: раздел не открыт"
tgx_logwait "planner: status=ready loaded=1" 300 && ok "X: «План» загружен" || bad "X: «План» не загрузился"
# 1) desktop → X
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOPLANNER=task:$TASK@15,event:$EVENT|$DAY|18:00|19:30@20" \
  "PARVANE_AUTOCLOUD=folder:$FOLDER@25" "PARVANE_AUTONOTES=note:$NOTE|Первая строка заметки@35")
wait_log "$AL" "autoplanner task $TASK → отправлено" 120 && ok "alice-desktop: задача добавлена" || bad "alice-desktop: задача не добавлена"
tgx_logwait "planner: .*задачи=\[[^]]*$TASK" 120 && ok "X: задача desktop пришла" || bad "X: задачи desktop нет"
tgx_logwait "события=\[[^]]*$EVENT" 60 && ok "X: событие desktop пришло" || bad "X: события desktop нет"
tgx_cmd '{"op":"sections","section":"knowledge"}' || bad "X: «Знания» не открыты"
wait_log "$AL" "autocloud folder $FOLDER → ok" 120 && ok "alice-desktop: папка облака создана" || bad "alice-desktop: папка не создана"
tgx_logwait "cloud: status=ready корень=\[[^]]*$FOLDER" 150 && ok "X: папка desktop в облаке" || bad "X: папки desktop нет"
wait_log "$AL" "autonotes note $NOTE → создана" 120 && ok "alice-desktop: заметка создана" || bad "alice-desktop: заметка не создана"
tgx_logwait "notes: status=ready заметки=\[[^]]*$NOTE" 150 && ok "X: заметка desktop в «Знаниях»" || bad "X: заметки desktop нет"
# 2) X → desktop
tgx_cmd "{\"op\":\"planner_add\",\"text\":\"$XTASK\"}" && ok "X: задача добавлена вводом текстом" || bad "X: задача не добавлена"
tgx_logwait "planner_add → ok" 30 || bad "X: planner_add без ok"
wait_log "$AL" "planner: status=ready loaded=1 задачи=\[[^]]*$XTASK" 120 && ok "alice-desktop: задача X пришла" || bad "alice-desktop: задачи X нет"
tgx_cmd "{\"op\":\"note_create\",\"title\":\"$XNOTE\",\"text\":\"Строка с телефона\"}" && ok "X: заметка создана" || bad "X: заметка не создана"
wait_log "$AL" "notes: status=ready заметки=\[[^]]*$XNOTE" 150 && ok "alice-desktop: заметка X пришла" || bad "alice-desktop: заметки X нет"
tgx_cmd "{\"op\":\"cloud_folder\",\"name\":\"$XFOLDER\"}" && ok "X: папка облака создана" || bad "X: папка не создана"
wait_log "$AL" "cloud: status=ready корень=\[[^]]*$XFOLDER" 150 && ok "alice-desktop: папка X пришла" || bad "alice-desktop: папки X нет"
grep -qa "$TASK\|$FOLDER\|$NOTE\|$XTASK\|$XNOTE\|$XFOLDER" "$SB"/domains.db* "$SB"/cloud.db* 2>/dev/null && bad "открытый текст разделов на сервере" \
  || ok "на сервере разделы только шифртекстом"
stop_pid "$AP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX SECTIONS"
