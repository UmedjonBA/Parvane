#!/usr/bin/env bash
# Parvane — пересылка медиа по v2: alice → bob фото; bob пересылает его carol;
# carol скачивает. Блоб в cloud доступен по секрету capability из содержимого
# (CAP-1), поэтому пересылка — то же содержимое новому адресату, без перезаливки.
# Проверяем: bob переслал («переслано медиа → carol»), carol получила медиа,
# file_id тот же, что у исходного, и файл у carol побайтово равен исходному.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-fwd.XXXXXX)"
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
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не готов"
AP=$(start_client "$A" alice@local PARVANE_AUTOSENDFILE="bob@local:$SRC")
FID=""
for _ in $(seq 1 90); do
  FID=$(grep "Parvane: медиа отправлено" "$A/td/log.txt" 2>/dev/null | head -1 | sed -n 's/.*(file \([0-9a-f-]\+\).*/\1/p')
  [ -n "$FID" ] && break
  sleep 1
done
# Убиваем alice сразу: её headless-петля иначе шлёт десятки загрузок и топит cloud
stop_pid "$AP"
[ -n "$FID" ] && ok "alice отправила фото (file ${FID:0:8}…)" || bad "alice не отправила фото"
wait_log "$B/td/log.txt" "входящее медиа .*alice@local" 60 && ok "bob получил фото" || bad "bob не получил фото"
stop_pid "$BP"
# carol поднимаем только теперь — меньше одновременной нагрузки на слабой машине
CP=$(start_client "$C" carol@local)
wait_log "$C/td/log.txt" "v2: готов" 90 || bad "carol не готова"
# bob пересылает последнее сообщение диалога alice → carol
BP=$(start_client "$B" bob@local PARVANE_AUTOFORWARD="alice@local:carol@local:6")
wait_log "$B/td/log.txt" "autoforward alice@local → carol@local" 40 || bad "bob: хук пересылки не сработал"
wait_log "$B/td/log.txt" "переслано медиа → carol@local" 40 && ok "bob отправил пересылку" || bad "bob не отправил пересылку"
wait_log "$C/td/log.txt" "входящее медиа .*bob@local" 60 && ok "carol получила пересланное фото" || bad "carol не получила пересланное фото"
sleep 3
# CAP-1: тот же блоб (file_id исходного); открытая копия у carol — во временном каталоге экземпляра
# (tdata/parvane-tmp/media), кэш tdata/parvane-media-cache зашифрован (ревью 21 окт)
GOT=$(ls -t "$C/td/tdata/parvane-tmp/media/${FID}_"* 2>/dev/null | head -1)
[ -n "$GOT" ] && cmp -s "$SRC" "$GOT" && ok "блоб у carol побайтово равен исходному" || bad "блоб у carol не совпал (got=$GOT)"
grep -qiE "Fatal|Unexpected in |ошибка скачивания медиа" "$A/td/log.txt" "$B/td/log.txt" "$C/td/log.txt" && bad "ошибки в логах" || ok "без фатальных ошибок"
stop_pid "$AP"; stop_pid "$BP"; stop_pid "$CP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ПЕРЕСЫЛКА МЕДИА"
