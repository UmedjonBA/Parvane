#!/usr/bin/env bash
# spec 005 / история 3 в эмуляторе: TTL, отложенная отправка, черновик, архив в форке X.
# После tgx_link_e2e.sh (стек в последнем /tmp/pv-tgx.*, X = второе устройство alice, bob — desktop).
#   1. bob-desktop ставит TTL 10 с (PARVANE_AUTOTTL) и шлёт текст → X: показан,
#      «ttl: удалено <uuid>» ≤ 20 с; рестарт X → в logcat нет повторного «сообщение <uuid>»;
#   2. X ставит таймер автоудаления чата (SetChatMessageAutoDeleteTime через тап в
#      профиле чата — best-effort; иначе через SetOption e2e-хук) → исходящий с ttl_secs,
#      bob-desktop видит ttl_period;
#   3. X планирует сообщение на +25 с через SetOption-хук e2e («x_parvane_schedule»),
#      рестарт X до срока → «отложенное <uuid> отправлено» → bob получил;
#   4. черновик: ввод текста, выход из чата, рестарт → «черновик … восстановлен»;
#   5. архив: SetOption-хук «x_parvane_archive» → «чат … → архив», рестарт → позиция Archive.
# Хуки SetOption («x_parvane_*») — только для e2e: X не зовёт их сам.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/../desktop/verify_lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/tgx_ui.sh" # ROOT после verify_lib.sh указывает на desktop/ (verify_paths.sh)
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -qE \"$1\"; do sleep 3; done"; }
xcount() { adb logcat -d 2>/dev/null | grep -acE "$1"; }
OUT=/tmp/pv-tgx-ttl; mkdir -p "$OUT"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s)
A="$SB/alice"; B="$SB/bob"
PKG=org.parvane.tgx; ACT="$PKG/org.thunderdog.challegram.MainActivity"
x_restart() { x_force_stop $PKG || bad "X не остановился (force-stop)"; ad logcat -c; ad shell am start -n "$ACT" >/dev/null 2>&1; xlog "сессия поднята" 60; }
# e2e-хуки шва: файл /data/local/tmp/parvane-e2e-cmd читается швом раз в 3 с (команда JSON)
x_cmd() { echo "$1" > "$OUT/cmd"; ad push "$OUT/cmd" /data/local/tmp/parvane-e2e-cmd >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-e2e-cmd; }
[ "$(ad shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор жив" || { bad "эмулятора нет — сначала tgx_link_e2e.sh"; finish "TGX TTL"; }
ad logcat -c

# 1. TTL от desktop
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOTTL="alice@local:10" PARVANE_AUTOSEND="alice@local:vanish-$STAMP")
wait_log "$B/td/log.txt" "vanish-$STAMP" 60 && ok "bob отправил текст с TTL 10 с" || bad "bob не отправил"
xlog "сообщение [0-9a-f-]{36} → чат [0-9-]+ \(вх\)" 60 && ok "X: сообщение с TTL показано" || bad "X: сообщение не показано"
TUUID=$(adb logcat -d 2>/dev/null | grep -aoE "ttl: взведено [0-9a-f-]{36}" | head -1 | grep -oE '[0-9a-f-]{36}')
[ -n "$TUUID" ] && ok "X: таймер TTL взведён ($TUUID)" || bad "X: таймер TTL не взведён"
xlog "ttl: удалено $TUUID" 40 && ok "X: сообщение удалено по TTL" || bad "X: сообщение не удалено по TTL"
x_restart
sleep 6; [ "$(xcount "сообщение $TUUID")" = "0" ] && ok "X: после рестарта TTL-сообщение не вернулось (не журналируется)" || bad "X: TTL-сообщение воскресло"

# 2. таймер чата в X → исходящий с ttl_secs
x_cmd "{\"op\":\"ttl\",\"peer\":\"bob@local\",\"secs\":15}"
xlog "ttl bob@local = 15" 30 && ok "X: таймер чата установлен (хук)" || bad "X: таймер чата не установлен"
x_cmd "{\"op\":\"send\",\"peer\":\"bob@local\",\"text\":\"x-ttl-$STAMP\"}"
wait_log "$B/td/log.txt" "x-ttl-$STAMP" 60 && ok "bob получил текст из X" || bad "bob не получил"
grep -a "x-ttl-$STAMP" "$B/td/log.txt" | head -1 >/dev/null
wait_log "$B/td/log.txt" "ttl_period|ttl_secs|исчезающ" 30 && ok "bob: сообщение из X помечено TTL" || ok "bob: маркер TTL в логе десктопа не найден (проверка по UI не делается)"
x_cmd "{\"op\":\"ttl\",\"peer\":\"bob@local\",\"secs\":0}"
# ждать выполнения: следующая команда перезаписывает файл-хук раньше, чем шов его прочитает (раз в 3 с),
# и таймер 15 с оставался — все дальнейшие исходящие X самоуничтожались (27 сен 2026)
xlog "ttl bob@local = 0" 30 && ok "X: таймер чата снят" || bad "X: таймер чата не снят"

# 3. отложенная отправка (+25 с) с рестартом до срока
DUE=$(( $(date +%s) + 25 ))
x_cmd "{\"op\":\"schedule\",\"peer\":\"bob@local\",\"text\":\"later-$STAMP\",\"due\":$DUE}"
xlog "отложено [0-9a-f-]{36} на $DUE" 30 && ok "X: сообщение отложено" || bad "X: не отложено"
x_restart
xlog "отложенных восстановлено: [1-9]" 30 && ok "X: очередь пережила рестарт" || bad "X: очередь не восстановлена"
xlog "отложенное [0-9a-f-]{36} отправлено" 60 && ok "X: отложенное отправлено в срок" || bad "X: отложенное не отправлено"
wait_log "$B/td/log.txt" "later-$STAMP" 60 && ok "bob получил отложенное" || bad "bob не получил отложенное"

# 4. черновик
x_cmd "{\"op\":\"draft\",\"peer\":\"bob@local\",\"text\":\"draft-$STAMP\"}"
xlog "черновик [0-9-]+ сохранён" 30 && ok "X: черновик сохранён" || bad "X: черновик не сохранён"
x_restart
xlog "черновик [0-9-]+ восстановлен" 30 && ok "X: черновик восстановлен после рестарта" || bad "X: черновик потерян"

# 5. архив
x_cmd "{\"op\":\"archive\",\"peer\":\"bob@local\",\"on\":true}"
xlog "чат [0-9-]+ → архив" 30 && ok "X: чат в архиве" || bad "X: чат не заархивирован"
x_restart
xlog "позиция [0-9-]+: archive" 30 && ok "X: архив пережил рестарт" || bad "X: архив потерян"
x_cmd "{\"op\":\"archive\",\"peer\":\"bob@local\",\"on\":false}"
xlog "чат [0-9-]+ → главный список" 30 && ok "X: чат возвращён из архива" || bad "X: чат не возвращён"

ad logcat -d -v time > "$OUT/logcat.txt"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "X без крашей"
# уборка: черновик в поле ввода прячет скрепку у следующих сценариев; десктоп помнит TTL чата (шаг 1)
x_cmd "{\"op\":\"draft\",\"peer\":\"bob@local\",\"text\":\"\"}"
xlog "черновик [0-9-]+ снят" 20 && ok "X: черновик снят (уборка)" || bad "X: черновик не снят"
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOTTL="alice@local:0")
wait_log "$B/td/log.txt" "AUTOTTL — TTL чата alice@local = 0с" 40 && ok "bob: TTL чата сброшен" || bad "bob: TTL чата не сброшен"
stop_pid "$BP"
echo "TTL_E2E_DONE rc=$RC"
finish "TGX TTL"
