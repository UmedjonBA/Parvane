#!/usr/bin/env bash
# Parvane — АВТО-проверка рендера медиа на приёме под Qt-VNC (софт-рендер).
# Отправитель sam — настоящий desktop-клиент (хук PARVANE_AUTOSENDFILE: штатный
# sendFile → блоб по capability + содержимое v2); приёмник rob — инстанс под
# VNC. По логу rob проверяем, что каждый тип инъецирован правильно и БЕЗ краха:
#   photo (jpg) → фото «получено фото … 800x600», file → документ, голосовое (…:voice)
#   и «кружок» (…:round) — вид медиа во входящем (kind=voice / kind=video_note).
# Плюс скриншот для ручного просмотра (gui_grab.py).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
PORT="${GUI_PORT:-5950}"
stack_start "${SCRATCH:-/tmp/parvane-mediaall}"
TMP="$SB/files"; mkdir -p "$TMP"
command -v ffmpeg >/dev/null || { echo "нет ffmpeg в PATH (нужен для тестового JPEG)"; exit 2; }

# тестовые файлы
ffmpeg -y -f lavfi -i "testsrc=size=800x600:duration=1:rate=1" -frames:v 1 "$TMP/p.jpg" >/dev/null 2>&1
printf 'parvane doc \x00\x01 %s' "$(date +%s)" > "$TMP/d.bin"
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -c:a libopus "$TMP/v.ogg" >/dev/null 2>&1
ffmpeg -y -f lavfi -i "testsrc=size=240x240:duration=2:rate=25" -f lavfi -i "sine=duration=2" \
  -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$TMP/r.mp4" >/dev/null 2>&1

R="$SB/rob"; S="$SB/sam"; LOG="$R/td/log.txt"; SL="$S/td/log.txt"
# VNC-приёмник rob (заводит журнал устройств v2 до отправки ему)
RP=$(start_client "$R" rob@local PARVANE_NO_LINK_OFFER=1 \
  QT_QPA_PLATFORM="vnc:port=$PORT,size=1280x800" QT_OPENGL=software LIBGL_ALWAYS_SOFTWARE=1 \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR")
wait_log "$LOG" "v2: готов" 90 || bad "rob: v2 не поднялся"

# sam шлёт по одному файлу за запуск (хук берёт один путь)
for f in p.jpg d.bin v.ogg:voice r.mp4:round; do
  SP=$(start_client "$S" sam@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSENDFILE=rob@local:$TMP/$f")
  wait_log "$SL" "медиа отправлено" 90 || bad "sam не отправил $f"
  sleep 2; stop_pid "$SP"
done
wait_log "$LOG" "получено медиа sam@local: " 60
wait_log "$LOG" "получено фото sam@local: " 30

echo "── лог приёма (rob) ──"; grep -aiE "получено (фото|медиа)|ASSERT" "$LOG" 2>/dev/null | tail -8; echo "──"
grep -qa "получено фото sam@local: 800x600" "$LOG" && ok "photo → фото 800x600" || bad "photo не как фото"
grep -qaE "получено медиа sam@local: .*\(([0-9]+) байт\)" "$LOG" && ok "file принят документом" || bad "file не принят"
wait_log "$LOG" "kind=voice\) → скачивание" 60 && ok "голосовое принято голосовым" || bad "голосовое не как voice"
wait_log "$LOG" "kind=video_note\) → скачивание" 60 && ok "кружок принят кружком" || bad "кружок не как video_note"
grep -qaiE "ASSERT|Fatal|Unexpected in " "$LOG" && bad "КРАШ/ASSERT при рендере медиа" || ok "без краха/ассертов"

# скриншот (открываем диалог) — заодно проверка «жив»: удачный grab = VNC-сервер
# форка отвечает, значит инстанс не упал при рендере медиа.
SHOT="$SB/media_all.png"
if python3 "$ROOT/gui_grab.py" 127.0.0.1 "$PORT" "$SHOT" 20 "250,190" >/dev/null 2>&1; then
  ok "инстанс жив, скриншот снят: $SHOT"
else
  bad "инстанс не ответил на VNC (возможно упал)"
fi

stop_pid "$RP"; stack_stop
finish "МЕДИА-РЕНДЕР"
