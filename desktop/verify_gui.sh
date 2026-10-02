#!/usr/bin/env bash
# Parvane — АВТО-проверка GUI форка без внешнего дисплея. Запускает бинарь под
# Qt-VNC платформой (софт-рендер), даёт ему прогрузиться, снимает скриншот
# через desktop/gui_grab.py (RFB-клиент) и печатает путь к PNG — агент читает
# его глазами. Опционально кликает (открыть диалог) и шлёт autosend/файл.
#
# Параметры через окружение:
#   GUI_ACCOUNT=bob@local:test-pass-2026       автологин (по умолчанию gui@local)
#   GUI_OUT=/path/shot.png           куда сохранить скриншот (по умолчанию /tmp/parvane_gui.png)
#   GUI_AUTOSEND="peer@local:текст"  (опц.) отправить текст при старте
#   GUI_AUTOSENDFILE="peer@local:/f" (опц.) отправить файл при старте
#   GUI_CLICKS="x,y;x,y"             (опц.) клики перед снимком (напр. открыть чат)
#   GUI_PORT=5906  GUI_SIZE=1280x800  GUI_WAIT=12   (опц.)
#   GUI_KEEP=1                        (опц.) не убивать инстанс после снимка
# Backend: если на 4222 уже кто-то слушает (демо-стек) — работаем с ним; иначе
# поднимаем свой временный стек (verify_lib.sh) и гасим его на выходе.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
PORT="${GUI_PORT:-5906}"
SIZE="${GUI_SIZE:-1280x800}"
WAIT="${GUI_WAIT:-12}"
OUT="${GUI_OUT:-/tmp/parvane_gui.png}"
ACCOUNT="${GUI_ACCOUNT:-gui@local:$PV_PASSWORD}"
WD="$(mktemp -d /tmp/pv-gui.XXXXXX)"

[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

OWN_STACK=0
if ! wait_port 4222 1; then
    OWN_STACK=1
    stack_up "$WD/stack"
fi

env_extra=()
[ -n "${GUI_AUTOSEND:-}" ]     && env_extra+=("PARVANE_AUTOSEND=$GUI_AUTOSEND")
[ -n "${GUI_AUTOSENDFILE:-}" ] && env_extra+=("PARVANE_AUTOSENDFILE=$GUI_AUTOSENDFILE")

setsid nohup env \
  QT_QPA_PLATFORM="vnc:port=$PORT,size=$SIZE" \
  QT_OPENGL=software LIBGL_ALWAYS_SOFTWARE=1 \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="$ACCOUNT" \
  "${env_extra[@]}" \
  "$BIN" -workdir "$WD/td" >"$WD/out.log" 2>&1 </dev/null & disown
PID=$!
echo "GUI(vnc:$PORT) pid $PID workdir $WD"

# ждём логина
for i in $(seq 1 "$WAIT"); do
    grep -q "Parvane: login OK" "$WD/td/log.txt" 2>/dev/null && break
    sleep 1
done
sleep 3  # дать UI отрисоваться / autosend улететь

if python3 "$ROOT/gui_grab.py" 127.0.0.1 "$PORT" "$OUT" 25 "${GUI_CLICKS:-}"; then
    echo "СКРИНШОТ: $OUT"
    RC=0
else
    echo "grab не удался"; RC=1
fi
grep -q "Parvane: login OK" "$WD/td/log.txt" 2>/dev/null || { echo "логин $ACCOUNT не прошёл (см. $WD/td/log.txt)"; RC=1; }

if [ "${GUI_KEEP:-0}" = "1" ]; then
    echo "инстанс оставлен (pid $PID, port $PORT). Гасить: kill $PID"
    [ "$OWN_STACK" = 1 ] && echo "временный стек оставлен в $WD/stack (nats 4222) — гасить вручную"
else
    kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
    [ "$OWN_STACK" = 1 ] && stack_stop
    rm -rf "$WD"
fi
exit "$RC"
