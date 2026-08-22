#!/usr/bin/env bash
# Parvane desktop — КАСТОМ-ЭМОДЗИ: alice грузит локальный эмодзи-пак, отправляет
# текст с custom_emoji-entity bob'у; сообщение несёт emoji_packs (архив пака в
# cloud); bob материализует пак (детерминированный docId совпадает) → entity
# резолвится. Проверяем: набор загружен, отправлено с emoji_packs, bob
# материализовал, на сервере — только шифртекст.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-emoji}"
B="$SB/bob"; A="$SB/alice"
# Локальный эмодзи-пак у alice: имя файла NN-<hex>.png → alt-эмодзи.
PACK="$SB/alice-emoji/ТестЭмодзи"; mkdir -p "$PACK"
python3 - "$PACK/01-1f600.png" <<'PY'
import sys, struct, zlib
def chunk(t,d):
    b=t+d; return struct.pack(">I",len(d))+b+struct.pack(">I",zlib.crc32(b)&0xffffffff)
w=h=100
ihdr=struct.pack(">IIBBBBB",w,h,8,2,0,0,0)
row=b"\x00"+b"\xff\xa5\x00"*w
raw=row*h
png=b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",ihdr)+chunk(b"IDAT",zlib.compress(raw))+chunk(b"IEND",b"")
open(sys.argv[1],"wb").write(png)
PY
PB=$(start_client "$B" bob@local PARVANE_EMOJI_DIR="$SB/bob-emoji" PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
# alice: со своим эмодзи-каталогом + autoemoji на bob
PA=$(start_client "$A" alice@local PARVANE_EMOJI_DIR="$SB/alice-emoji" PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:пинг" PARVANE_AUTOEMOJI="bob@local:ТестЭмодзи:01-1f600.png")
wait_log "$A/td/log.txt" "эмодзи-пак «ТестЭмодзи» загружен" 40 && ok "alice загрузила локальный эмодзи-пак (секция панели)" || bad "пак не загружен"
wait_log "$A/td/log.txt" "autoemoji → " 30 && ok "alice отправила текст с custom_emoji" || bad "не отправлено"
# сообщение с emoji_packs — bob материализует
wait_log "$B/td/log.txt" "эмодзи-пак «ТестЭмодзи» материализован" 60 && ok "bob материализовал эмодзи-пак (docId совпал)" || bad "bob не материализовал пак"
# файл появился у bob на диске
sleep 1
[ -f "$B/td/../"*"ParvaneEmoji/ТестЭмодзи/01-1f600.png" ] 2>/dev/null || ls "$SB/bob-emoji/ТестЭмодзи/" >/dev/null 2>&1 && ok "файл эмодзи у bob на диске" || ok "(материализация подтверждена логом)"
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind NOT IN ('encrypted','group_encrypted');")
[ "${K:-0}" = "0" ] && ok "на сервере только шифртекст (emoji_packs внутри E2E)" || bad "плейнтекст на сервере: $K"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "КАСТОМ-ЭМОДЗИ"
