#!/usr/bin/env bash
# Parvane desktop — свои наборы стикеров (ревью UI 7 ноя, п. 23): удаление набора и порядок наборов в окне
# «Стикеры» (ApiWrap::saveStickerSets — хук PARVANE_AUTOUI stickerorder/stickerremove, тот же вход) переживают
# перезапуск. Без правки удаление уходило в MTProto (messages.uninstallStickerSet), каталог набора оставался и набор
# возвращался при следующем запуске; порядок брался по имени каталога.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-sticker-sets}"
A="$SB/alice"; AL="$A/td/log.txt"; PACKS="$SB/packs"
for n in Альфа Бета Гамма; do mkdir -p "$PACKS/$n"; done
python3 - "$PACKS" <<'PY'
import sys, struct, zlib, os
def png(path, rgb):
    def chunk(t, d):
        b = t + d
        return struct.pack(">I", len(d)) + b + struct.pack(">I", zlib.crc32(b) & 0xffffffff)
    w = h = 64
    raw = (b"\x00" + bytes(rgb) * w) * h
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                          + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
for i, n in enumerate(["Альфа", "Бета", "Гамма"]):
    png(os.path.join(sys.argv[1], n, "01-1f600.png"), (40 * i + 60, 90, 160))
PY
P=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_STICKERS_DIR="$PACKS" \
  "PARVANE_AUTOUI=stickerlist:-@6,stickerorder:Гамма;Альфа;Бета@8,stickerremove:Бета@10,stickerlist:-@14")
wait_log "$AL" "autoui наборы стикеров: Альфа;Бета;Гамма" 40 && ok "три набора по имени каталога" || bad "наборы не загружены"
wait_log "$AL" "порядок наборов сохранён" 30 && ok "порядок сохранён на устройстве" || bad "порядок не сохранён"
wait_log "$AL" "набор «Бета» удалён \(каталог и журнал состояния\)" 30 && ok "набор удалён — каталог и журнал" \
  || bad "набор не удалён"
wait_log "$AL" "autoui наборы стикеров: Гамма;Альфа$" 20 && ok "после правки: Гамма, Альфа" || bad "порядок/удаление в памяти неверны"
[ ! -e "$PACKS/Бета" ] && ok "каталога удалённого набора нет" || bad "каталог удалённого набора остался"
stop_pid "$P"
P=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_STICKERS_DIR="$PACKS" "PARVANE_AUTOUI=stickerlist:-@8")
wait_log "$AL" "autoui наборы стикеров: " 40 || bad "после перезапуска наборов нет"
grep -aq "autoui наборы стикеров: Гамма;Альфа$" "$AL" && ok "после перезапуска: удалённого нет, порядок прежний" \
  || bad "после перезапуска: $(grep -a 'autoui наборы стикеров' "$AL" | tail -1)"
grep -qiE "Fatal|Unexpected in " "$AL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P"; stack_stop
finish "СВОИ НАБОРЫ СТИКЕРОВ (п. 23)"
