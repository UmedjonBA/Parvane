#!/usr/bin/env bash
# Parvane — пересылка в несколько чатов из окна выбора (spec 030, «тупики UI» 21 окт 2026).
# alice → bob фото; bob пересылает его СРАЗУ carol и dave штатным колбэком окна выбора чатов
# (ShareBox::DefaultForwardCallback, хук PARVANE_AUTOFORWARD_MULTI). Раньше этот путь слал
# messages.forwardMessages MTProto и не доходил ни до кого; теперь — путь одиночной пересылки
# (ApiWrap::forwardMessages → MirrorForward) для каждого получателя.
# Проверяем: хук сработал, bob отправил обоим, carol и dave получили фото, байты равны исходным.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-fwdm.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"; D="$SB/dave"
mkdir -p "$A/td" "$B/td" "$C/td" "$D/td"
SRC="$SB/photo.png"
# валидный PNG 2x2 (base64) + хвост со штампом — целостность байт
base64 -d > "$SRC" <<'PNG'
iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DwHwyBFAAAdDwF/dyJPjQAAAAASUVORK5CYII=
PNG
printf 'FWDM %s' "$STAMP" >> "$SRC"
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не готов"
AP=$(start_client "$A" alice@local PARVANE_AUTOSENDFILE="bob@local:$SRC")
FID=""
for _ in $(seq 1 90); do
  FID=$(grep "Parvane: медиа отправлено" "$A/td/log.txt" 2>/dev/null | head -1 | sed -n 's/.*(file \([0-9a-f-]\+\).*/\1/p')
  [ -n "$FID" ] && break
  sleep 1
done
stop_pid "$AP"
[ -n "$FID" ] && ok "alice отправила фото (file ${FID:0:8}…)" || bad "alice не отправила фото"
wait_log "$B/td/log.txt" "входящее медиа .*alice@local" 60 && ok "bob получил фото" || bad "bob не получил фото"
stop_pid "$BP"
# получатели заводятся до пересылки: v2 шлёт только тем, у кого опубликовано устройство
CP=$(start_client "$C" carol@local)
wait_log "$C/td/log.txt" "v2: готов" 90 || bad "carol не готова"
DP=$(start_client "$D" dave@local)
wait_log "$D/td/log.txt" "v2: готов" 90 || bad "dave не готов"
BP=$(start_client "$B" bob@local PARVANE_AUTOFORWARD_MULTI="alice@local:carol@local,dave@local:10")
wait_log "$B/td/log.txt" "autoforward-multi alice@local → carol@local, dave@local" 60 \
  && ok "bob: пересылка в два чата из окна выбора" || bad "bob: хук пересылки в несколько чатов не сработал"
wait_log "$B/td/log.txt" "переслано медиа → carol@local" 40 && ok "bob отправил carol" || bad "bob не отправил carol"
wait_log "$B/td/log.txt" "переслано медиа → dave@local" 40 && ok "bob отправил dave" || bad "bob не отправил dave"
wait_log "$C/td/log.txt" "входящее медиа .*bob@local" 60 && ok "carol получила пересланное фото" || bad "carol не получила"
wait_log "$D/td/log.txt" "входящее медиа .*bob@local" 60 && ok "dave получил пересланное фото" || bad "dave не получил"
sleep 3
for W in "$C" "$D"; do
  GOT=$(ls -t "$W/td/tdata/parvane-tmp/media/${FID}_"* 2>/dev/null | head -1)
  [ -n "$GOT" ] && cmp -s "$SRC" "$GOT" && ok "блоб у $(basename "$W") побайтово равен исходному" \
    || bad "блоб у $(basename "$W") не совпал (got=$GOT)"
done
grep -qiE "Fatal|Unexpected in |ошибка скачивания медиа|ошибка пересылки" \
  "$A/td/log.txt" "$B/td/log.txt" "$C/td/log.txt" "$D/td/log.txt" && bad "ошибки в логах" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stop_pid "$CP"; stop_pid "$DP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ПЕРЕСЫЛКА В НЕСКОЛЬКО ЧАТОВ"
