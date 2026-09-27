#!/usr/bin/env bash
# spec 005 / история 2 в эмуляторе: опросы в форке X. После tgx_link_e2e.sh
# (стек в последнем /tmp/pv-tgx.*, X = второе устройство alice, bob — desktop).
#   1. bob-desktop создаёт опрос (PARVANE_AUTOPOLL) → X: «опрос <uuid>: 3 вариантов»;
#   2. X голосует тапом по варианту → «голос alice@local → опрос …»,
#      desktop bob принял голос («опрос … — голос … от alice@local»);
#   3. alice-desktop (первое устройство, PARVANE_AUTOVOTE) голосует в том же опросе →
#      X: «голос alice@local → … [1]» и UpdateMessageContent без перезапуска;
#   4. X создаёт опрос через меню вложений (вкладка «Опрос» возвращена оверлеем):
#      best-effort по дереву uiautomator — при удаче desktop bob: «опрос … инъецирован».
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/../desktop/verify_lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/tgx_ui.sh" # ROOT после verify_lib.sh указывает на desktop/ (verify_paths.sh)
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -qE \"$1\"; do sleep 3; done"; }
# e2e-хук шва (JSON-команда в /data/local/tmp/parvane-e2e-cmd, читается раз в 3 с)
x_cmd() { echo "$1" > "$OUT/cmd"; ad push "$OUT/cmd" /data/local/tmp/parvane-e2e-cmd >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-e2e-cmd; }
OUT=/tmp/pv-tgx-polls; mkdir -p "$OUT"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s); Q="Вопрос-$STAMP"
A="$SB/alice"; B="$SB/bob"
[ "$(ad shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор жив" || { bad "эмулятора нет — сначала tgx_link_e2e.sh"; finish "TGX POLLS"; }
ad logcat -c

# 1. опрос desktop → X (1-на-1 bob → alice)
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOPOLL="alice@local:$Q:да,нет,воздержусь")
wait_log "$B/td/log.txt" "опрос создан → alice@local" 60 && ok "bob создал опрос" || bad "bob не создал опрос"
xlog "опрос [0-9a-f-]{36}: 3 вариантов" 90 && ok "X: опрос принят (3 варианта)" || bad "X: опрос не принят"
PUUID=$(adb logcat -d 2>/dev/null | grep -aoE "опрос [0-9a-f-]{36}: 3 вариантов" | head -1 | grep -oE '[0-9a-f-]{36}')
echo "PUUID=$PUUID"
sleep 3; ad exec-out screencap -p > "$OUT/01-list.png"

# 2. X голосует тапом по первому варианту (сначала — к списку чатов)
ui_reset; ad shell input tap 540 330; sleep 4; ui_close_panel; ad exec-out screencap -p > "$OUT/02-chat.png"
# Варианты X рисует на canvas (в дереве uiautomator их нет): тап по первой строке последнего
# пузыря (опрос — последнее сообщение, ~445 px над его низом); если UI-тап не попал —
# тот же путь шва (SetPollAnswer) через e2e-хук, чтобы проверить голосование детерминированно
ui_tap '^да$' 3 || ad shell input tap 150 1690
sleep 4; ad exec-out screencap -p > "$OUT/03-voted.png"
if xlog "голос alice@local → опрос $PUUID \[0\]" 15; then ok "X: голос отправлен тапом по варианту и применён"
else
  x_cmd "{\"op\":\"vote\",\"uuid\":\"$PUUID\",\"option\":0}"
  xlog "голос alice@local → опрос $PUUID \[0\]" 30 && ok "X: голос отправлен (SetPollAnswer через хук; UI-тап не попал, см. $OUT/03-voted.png)" || bad "X: голос не отправлен (см. $OUT/02-chat.png)"
fi
wait_log "$B/td/log.txt" "опрос $PUUID — .* от alice@local" 60 && ok "desktop bob: голос из X принят" || bad "desktop bob: голос из X не принят"

# 3. второй голос без перезапуска X: alice-desktop (первое устройство alice) голосует
#    в том же входящем опросе (PARVANE_AUTOVOTE=1) → X видит смену голоса своего адреса
#    и шлёт UpdateMessageContent (desktop-хук опросов умеет только 1-на-1)
kill $(pgrep -f "workdir $SB/alice/t[d]") 2>/dev/null; sleep 2
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOVOTE="1")
wait_log "$A/td/log.txt" "autovote — опрос [0-9]+, вариант 1" 90 && ok "alice-desktop проголосовала (autovote)" || bad "alice-desktop не проголосовала"
xlog "голос alice@local → опрос $PUUID \[1\]" 60 && ok "X: голос с другого устройства применён без перезапуска" || bad "X: голос с другого устройства не пришёл"
xlog "→ X UpdateMessageContent" 20 && ok "X: UpdateMessageContent ушёл в UI" || bad "X: UpdateMessageContent не отправлен"
wait_log "$B/td/log.txt" "опрос $PUUID — .* от alice@local" 60 || bad "desktop bob: второй голос не принят"

# 4. best-effort: X создаёт опрос через меню вложений
# меню вложений X сначала просит доступ к фото/видео — выдаём заранее (и на всякий случай жмём «Разрешить»)
for perm in READ_MEDIA_IMAGES READ_MEDIA_VIDEO READ_EXTERNAL_STORAGE; do ad shell pm grant org.parvane.tgx android.permission.$perm 2>/dev/null; done
ui_reset; ad shell input tap 540 330; sleep 4; ui_close_panel
# при тексте в поле (черновик из tgx_ttl_scheduled_flow.sh) скрепка заменяется кнопкой отправки — очищаем поле (Ctrl+A, Del)
ad shell input tap 540 2208; sleep 1; ad shell input keycombination 113 29; ad shell input keyevent 67; sleep 1; ad shell input keyevent 111; sleep 1
ui_tap 'id/msg_attach' 5 || ad shell input tap 890 2208; sleep 3
ui_tap 'Разрешить|Allow|permission_allow' 3 && sleep 2; ui_in_chat && grep -q 'id/msg_attach' "$UI_XML" || true; ad exec-out screencap -p > "$OUT/04-attach.png"
# пятая иконка нижней панели меню вложений (без текста в дереве) — тап по координатам, форма — по полю вопроса
ui_tap 'Опрос|Poll|CreatePoll' 3 || ad shell input tap 987 2200
sleep 3; ad exec-out screencap -p > "$OUT/05-create-poll.png"
if ui_dump && grep -qE 'Question|Вопрос|New Poll|Новый опрос' "$UI_XML"; then
  ok "вкладка «Опрос» открыла форму создания"
  if ui_tap 'Question|Вопрос' 5; then
    ad shell input text "Iz-X-$STAMP"; sleep 1
    # поле варианта — плейсхолдер «Вариант»/«Option» (точное совпадение: «Варианты ответа» — заголовок),
    # следующее — «Добавить ответ…»/«Add an option…»; кнопка отправки — кружок id/btn_done (появляется, когда опрос валиден)
    ui_tap '^(Вариант|Option)$' 5 && { ad shell input text "A"; sleep 1; }
    ui_tap '^(Добавить ответ|Add an option)' 5 && { ad shell input text "B"; sleep 1; }
    ad exec-out screencap -p > "$OUT/06-filled.png"
    ui_tap 'id/btn_done' 8 || bad "кнопка отправки опроса (btn_done) не появилась (см. $OUT/06-filled.png)"
    sleep 5
    # десктоп не пишет вопрос в лог — сверяем uuid последней отправки X («отправлено msg <uuid>») с инъекцией у bob
    XU=$(adb logcat -d 2>/dev/null | grep -aoE "отправлено msg [0-9a-f-]{36}" | tail -1 | grep -oE '[0-9a-f-]{36}')
    [ -n "$XU" ] && ok "X: опрос из формы отправлен ($XU)" || bad "X: опрос из формы не отправлен (см. $OUT/06-filled.png)"
    wait_log "$B/td/log.txt" "опрос ${XU:-none} \(.*\) от alice@local инъецирован" 60 && ok "desktop bob: опрос из X принят (оба формата имён)" || bad "desktop bob: опрос из X не принят (см. $OUT/06-filled.png)"
  else
    bad "экран создания опроса: поле вопроса не найдено (см. $OUT/05-create-poll.png)"
  fi
else
  bad "вкладка «Опрос» не открыла форму (см. $OUT/05-create-poll.png)"
fi

ad logcat -d -v time > "$OUT/logcat.txt"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "X без крашей"
ui_reset
stop_pid "$BP"
echo "POLLS_E2E_DONE rc=$RC"
finish "TGX POLLS"
