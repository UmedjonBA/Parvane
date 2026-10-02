#!/usr/bin/env bash
# Parvane — комплексная АВТО-проверка рендера всех типов медиа на приёме.
# Кладёт настоящие файлы на шину (craft_media.py) и проверяет по логу форка
# (VNC-инстанс), что каждый тип инъецирован правильно и БЕЗ краха:
#   photo → фото (получено фото WxH), file → документ, voice → голос,
#   video_note → кружок. Плюс скриншот для ручного просмотра.
# Так ловятся баги, которые не видны через отправку из content (буфер/запись).
#
# Поднимает свой чистый backend на временных БД (verify_lib.sh: stack_up).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
export PATH="$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
URL="nats://127.0.0.1:4222"
TMP="$(mktemp -d /tmp/parvane-mediaall.XXXXXX)"
PORT=5950
CLIENTS=()

cleanup() {
    for p in "${CLIENTS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
    stack_stop
    rm -rf "$TMP"
}
trap cleanup EXIT

# чистый backend на временных БД (общий подъём стека из verify_lib.sh)
stack_up "$TMP/stack"
wait_log "$TMP/stack/messenger.log" "NATS подключён" 10 || { echo "backend не поднялся"; exit 2; }

# тестовые файлы
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -c:a libopus "$TMP/v.ogg" >/dev/null 2>&1
ffmpeg -y -f lavfi -i "testsrc=size=240x240:duration=2:rate=15" -c:v libx264 -pix_fmt yuv420p "$TMP/vn.mp4" >/dev/null 2>&1
ffmpeg -y -f lavfi -i "testsrc=size=800x600:duration=1:rate=1" -frames:v 1 "$TMP/p.jpg" >/dev/null 2>&1
printf 'parvane doc \x00\x01 %s' "$(date +%s)" > "$TMP/d.bin"

# VNC-приёмник rob
WD="$TMP/rob"; mkdir -p "$WD"
setsid nohup env QT_QPA_PLATFORM="vnc:port=$PORT,size=1280x800" QT_OPENGL=software LIBGL_ALWAYS_SOFTWARE=1 \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN="rob@local:${PV_PASSWORD:-test-pass-2026}" \
  "$BIN" -workdir "$WD/td" >"$WD/o.log" 2>&1 </dev/null & disown
CLIENTS+=($!)
sleep 6

# шлём все типы от sam
python3 "$ROOT/craft_media.py" sam@local rob@local photo "$TMP/p.jpg" 0 800 600 >/dev/null 2>&1
python3 "$ROOT/craft_media.py" sam@local rob@local file "$TMP/d.bin" >/dev/null 2>&1
python3 "$ROOT/craft_media.py" sam@local rob@local voice "$TMP/v.ogg" 2 >/dev/null 2>&1
python3 "$ROOT/craft_media.py" sam@local rob@local video_note "$TMP/vn.mp4" 2 240 240 >/dev/null 2>&1
sleep 5

LOG="$WD/td/log.txt"
echo "── лог приёма (rob) ──"; grep -iE "получено (фото|медиа)|ASSERT" "$LOG" 2>/dev/null | tail -8; echo "──"

grep -q "получено фото.*sam@local: 800x600" "$LOG" 2>/dev/null && ok "photo → фото 800x600" || bad "photo не как фото"
grep -q "получено медиа.*sam@local: voice" "$LOG" 2>/dev/null && ok "voice принят" || bad "voice не принят"
grep -q "получено медиа.*sam@local: video_note" "$LOG" 2>/dev/null && ok "video_note принят" || bad "video_note не принят"
grep -qE "получено медиа.*sam@local: (d\.bin|file)" "$LOG" 2>/dev/null && ok "file принят документом" || bad "file не принят"
grep -qiE "ASSERT|Fatal|Unexpected in " "$LOG" 2>/dev/null && bad "КРАШ/ASSERT при рендере медиа" || ok "без краха/ассертов"

# скриншот (открываем диалог) — заодно проверка «жив»: удачный grab = VNC-сервер
# форка отвечает, значит инстанс не упал при рендере медиа.
SHOT="$TMP/media_all.png"
if python3 "$ROOT/gui_grab.py" 127.0.0.1 "$PORT" "$SHOT" 20 "250,190" >/dev/null 2>&1; then
    ok "инстанс жив, скриншот снят"
    cp "$SHOT" /tmp/parvane_media_all.png 2>/dev/null && echo "скриншот: /tmp/parvane_media_all.png"
else
    bad "инстанс не ответил на VNC (возможно упал)"
fi

[ "$RC" -eq 0 ] && printf '\033[32mМЕДИА-РЕНДЕР (все типы): OK\033[0m\n' || printf '\033[31mМЕДИА-РЕНДЕР: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
