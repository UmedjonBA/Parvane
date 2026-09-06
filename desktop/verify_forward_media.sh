#!/usr/bin/env bash
# Parvane — пересылка медиа с перезаливкой блоба (гранты cloud только при
# загрузке): alice → bob фото; bob пересылает его carol; carol скачивает.
# Проверяем: у bob лог «блоб перезалит … → carol», carol получила медиа и блоб
# на диске равен исходному.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-fwd.XXXXXX)"
MEDIA_DIR="${TMPDIR:-/tmp}/parvane-media"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"; mkdir -p "$A/td" "$B/td" "$C/td"
SRC="$SB/photo.png"
# валидный PNG 2x2 (base64) + хвост со штампом — целостность байт
base64 -d > "$SRC" <<'PNG'
iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DwHwyBFAAAdDwF/dyJPjQAAAAASUVORK5CYII=
PNG
printf 'FWD %s' "$STAMP" >> "$SRC"
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не готов"
AP=$(start_client "$A" alice@local PARVANE_AUTOSENDFILE="bob@local:$SRC")
FID=""
for _ in $(seq 1 40); do
  FID=$(grep "Parvane: медиа отправлено" "$A/td/log.txt" 2>/dev/null | head -1 | sed -n 's/.*(file \([0-9a-f-]\+\).*/\1/p')
  [ -n "$FID" ] && break
  sleep 1
done
# Убиваем alice сразу: её headless-петля иначе шлёт десятки загрузок и топит cloud
stop_pid "$AP"
[ -n "$FID" ] && ok "alice отправила фото (file ${FID:0:8}…)" || bad "alice не отправила фото"
wait_log "$B/td/log.txt" "входящее медиа .*alice@local" 40 && ok "bob получил фото" || bad "bob не получил фото"
stop_pid "$BP"
# carol поднимаем только теперь — меньше одновременной нагрузки на слабой машине
CP=$(start_client "$C" carol@local)
wait_log "$C/td/log.txt" "E2E-устройство готово" 40 || bad "carol не готова"
# bob пересылает последнее сообщение диалога alice → carol
BP=$(start_client "$B" bob@local PARVANE_AUTOFORWARD="alice@local:carol@local:6")
wait_log "$B/td/log.txt" "autoforward alice@local → carol@local" 40 || bad "bob: хук пересылки не сработал"
wait_log "$B/td/log.txt" "пересылка — блоб перезалит .* для carol@local" 60 && ok "bob перезалил блоб под carol" || bad "bob не перезалил блоб"
NFID=$(grep -oE "блоб перезалит [0-9a-f-]+ → [0-9a-f-]+ для carol@local" "$B/td/log.txt" | tail -1 | awk '{print $5}')
wait_log "$B/td/log.txt" "переслано медиа → carol@local" 40 && ok "bob отправил пересылку" || bad "bob не отправил пересылку"
wait_log "$C/td/log.txt" "входящее медиа .*bob@local" 60 && ok "carol получила пересланное фото" || bad "carol не получила пересланное фото"
sleep 3
GOT=$(ls -t "$MEDIA_DIR/${NFID}_"* 2>/dev/null | head -1)
[ -n "$GOT" ] && cmp -s "$SRC" "$GOT" && ok "блоб у carol побайтово равен исходному" || bad "блоб у carol не совпал (got=$GOT)"
grep -qiE "Fatal|Unexpected in |ошибка скачивания медиа" "$A/td/log.txt" "$B/td/log.txt" "$C/td/log.txt" && bad "ошибки в логах" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stop_pid "$CP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ПЕРЕСЫЛКА МЕДИА"
