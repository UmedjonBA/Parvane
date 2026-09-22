#!/usr/bin/env bash
# Parvane desktop — CONFORMANCE PACK-1 и EMOJI-1 (conformance/sync-rules.json).
# PACK-1: архив пака грузится в cloud ПОД НАБОР ПОЛУЧАТЕЛЕЙ — alice шлёт эмодзи
#   одного пака сначала bob'у, затем carol; в облаке должно появиться ДВА архива
#   (переиспользование ссылки, выданной другому получателю, — нарушение).
# EMOJI-1: docId считается от ИМЕНИ ИЗ ССЫЛКИ — пак с нормализуемым именем
#   «Pv.Raw!77» распаковывается у bob в каталог «PvRaw77», но после рестарта
#   грузится под сырым именем (иначе docId разъедутся с отправителем).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-conformance-packs}"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"
RAW='Pv.Raw!77'
NORM='PvRaw77'
PACK="$SB/alice-emoji/$RAW"; mkdir -p "$PACK"
python3 - "$PACK/01-1f600.png" <<'PY'
import sys, struct, zlib
def chunk(t, d):
    b = t + d
    return struct.pack(">I", len(d)) + b + struct.pack(">I", zlib.crc32(b) & 0xffffffff)
w = h = 100
ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
raw = (b"\x00" + b"\x20\xc0\x40" * w) * h
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY

PB=$(start_client "$B" bob@local PARVANE_EMOJI_DIR="$SB/bob-emoji" PARVANE_NO_LINK_OFFER=1)
PC=$(start_client "$C" carol@local PARVANE_EMOJI_DIR="$SB/carol-emoji" PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
wait_log "$C/td/log.txt" "E2E-устройство готово" 40 || bad "carol не поднялась"

# alice в ОДНОМ сеансе шлёт эмодзи пака двум разным получателям
PA=$(start_client "$A" alice@local PARVANE_EMOJI_DIR="$SB/alice-emoji" PARVANE_NO_LINK_OFFER=1 \
  PARVANE_AUTOSEND="bob@local:пинг" PARVANE_AUTOEMOJI="bob@local,carol@local,bob@local:$RAW:01-1f600.png")
wait_log "$A/td/log.txt" "эмодзи-пак «$RAW» загружен" 40 && ok "alice загрузила локальный пак «$RAW»" || bad "пак не загружен"
wait_log "$B/td/log.txt" "эмодзи-пак «$RAW» материализован" 60 && ok "bob материализовал пак" || bad "bob не материализовал пак"
wait_log "$C/td/log.txt" "эмодзи-пак «$RAW» материализован" 90 && ok "carol материализовала пак" || bad "carol не материализовала пак"

# PACK-1: три отправки (bob, carol, снова bob) — ровно ДВА архива:
#  «другой получатель» → новый архив, «тот же получатель» → переиспользование.
#  Третья отправка идёт на t+15 с, ждём её появления у bob перед подсчётом.
wait_log "$A/td/log.txt" "autoemoji → " 40 || bad "autoemoji не отработал"
sleep 12
ARCHIVES=$(sqlite3 "$SB/cloud.db" "SELECT COUNT(*) FROM files WHERE filename = 'emoji.pvpk';")
[ "${ARCHIVES:-0}" = "2" ] \
  && ok "PACK-1: ровно два архива на три отправки — новый получатель грузит, повторный переиспользует" \
  || bad "PACK-1: архивов в cloud $ARCHIVES вместо 2 — ссылка переиспользована для чужого получателя либо архив грузится на каждую отправку"

# EMOJI-1: каталог нормализован, сырое имя сохранено рядом
DEST="$SB/bob-emoji/$NORM"
[ -d "$DEST" ] && ok "пак распакован в нормализованный каталог «$NORM»" || bad "нет каталога «$NORM» у bob"
[ "$(cat "$DEST/.pvname" 2>/dev/null)" = "$RAW" ] \
  && ok "EMOJI-1: сырое имя пака сохранено рядом с каталогом" \
  || bad "EMOJI-1: сырого имени пака нет — после рестарта docId разъедутся"

# EMOJI-1: после рестарта bob грузит пак под сырым именем
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_EMOJI_DIR="$SB/bob-emoji" PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "эмодзи-пак «$RAW» загружен \(каталог «$NORM»\)" 60 \
  && ok "EMOJI-1: после рестарта пак загружен под именем из ссылки" \
  || bad "EMOJI-1: после рестарта пак загружен под именем каталога"

# EMOJI-1, case «кириллица» (sync-rules.json): имя из букв вне ASCII
# нормализацию переживает целиком (isLetterOrNumber верно для кириллицы), и
# проверяется именно round-trip UTF-8: сырое имя пишется и читается из .pvname
# без порчи, иначе docId разъедутся с отправителем
CYR='ТестЭмодзи'
CYRPACK="$SB/alice-emoji/$CYR"; mkdir -p "$CYRPACK"
cp "$PACK/01-1f600.png" "$CYRPACK/01-1f600.png"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_EMOJI_DIR="$SB/alice-emoji" PARVANE_NO_LINK_OFFER=1 \
  PARVANE_AUTOSEND="bob@local:пинг2" PARVANE_AUTOEMOJI="bob@local:$CYR:01-1f600.png")
wait_log "$B/td/log.txt" "эмодзи-пак «$CYR» материализован" 90 \
  && ok "EMOJI-1/кириллица: bob материализовал пак «$CYR»" \
  || bad "EMOJI-1/кириллица: bob не материализовал пак «$CYR»"
CYRDEST="$SB/bob-emoji/$CYR"
[ "$(cat "$CYRDEST/.pvname" 2>/dev/null)" = "$CYR" ] \
  && ok "EMOJI-1/кириллица: сырое имя сохранено без порчи кодировки" \
  || bad "EMOJI-1/кириллица: .pvname не совпадает с «$CYR» (порча UTF-8)"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_EMOJI_DIR="$SB/bob-emoji" PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "эмодзи-пак «$CYR» загружен" 60 \
  && ok "EMOJI-1/кириллица: после рестарта пак загружен под сырым именем" \
  || bad "EMOJI-1/кириллица: после рестарта имя пака разъехалось"

K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind NOT IN ('encrypted','group_encrypted');")
[ "${K:-0}" = "0" ] && ok "на сервере только шифртекст" || bad "плейнтекст на сервере: $K"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" "$C/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stop_pid "$PC"; stack_stop
finish "CONFORMANCE PACK-1/EMOJI-1"
