#!/usr/bin/env bash
# spec 035 T124 (US2, FR-010…FR-013, правило STATE-1 на state.v2): два устройства одного аккаунта БЕЗ связи правят
# РАЗНЫЕ поля одного объекта личного состояния — папки (alice1 переименовывает, alice2 добавляет в неё чат) и
# контакта (alice1 задаёт своё имя, alice2 — заметку). После возвращения в сеть оба изменения на обоих устройствах:
# сведение по полям (регистр на поле, патч `set`/`clear`), а не «последняя запись объекта целиком» (LWW по объекту
# теряет одно из двух). Падает без правки: прежний журнал state.v1 сводит объект целиком, а с spec 035 сервер
# прежнюю запись state.append и вовсе отвергает (UPGRADE_REQUIRED).
# Пара с web (тот же сценарий web ↔ desktop): scripts/run_protocol_mixed_e2e.sh state-patch-desktop.
# Заодно «В избранное» у стикера между устройствами (spec 035 T126, FR-075).
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*). Данные — выдуманные.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-state-patch"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"; C="$SB/carol"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"
OFFLINE=PARVANE_GATEWAY_URL=127.0.0.1:9

# ── собеседники и чаты у alice ───────────────────────────────────────────────
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
# carol пишет alice первой: чат с ней есть на обоих устройствах alice (в папку добавляют существующий чат)
PC=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:привет-от-carol-$S")
wait_log "$BL" "v2: готов" 90 && wait_log "$CL" "v2: готов" 90 && ok "bob и carol: v2 готовы" || bad "собеседники не поднялись"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOSEND_V2=bob@local:знакомство-$S" \
  "PARVANE_AUTOFOLDER=Работа:bob@local" "PARVANE_AUTOPATCH=contact-name|bob@local|Боб@12")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2 готова" || bad "alice1: v2 не поднялась"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): знакомство-$S" 60 || bad "bob не получил текст alice1"
wait_log "$L1" "входящее msg [0-9a-f-]+ \(carol@local\): привет-от-carol-$S" 150 || bad "alice1 не получила текст carol"
wait_log "$L1" "AUTOFOLDER создал папку 'Работа'" 30 && ok "alice1: папка «Работа» с bob" || bad "alice1: папка не создана"
stop_pid "$PB"; stop_pid "$PC"

P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1)
wait_linked "$L2" 150 && ok "alice2 привязана" || bad "alice2 не привязана"
wait_log "$L2" "журнал личного состояния подключён" 90 || bad "alice2: журнал состояния не подключён"
wait_log "$L2" "журнал состояния → папки" 60 && ok "alice2: папка пришла из журнала" || bad "alice2: папки нет"
wait_log "$L2" "журнал состояния → контакты" 60 && ok "alice2: контакт bob пришёл из журнала" || bad "alice2: контакта нет"
wait_log "$L2" "msg [0-9a-f-]+ \(carol@local\): привет-от-carol-$S" 60 || bad "alice2: чата с carol нет"
sleep 3
stop_pid "$P1"; stop_pid "$P2"

# ── без связи: alice1 — название папки и своё имя bob; alice2 — чат carol в папку и заметка bob ───────────
P1=$(start_client "$A1" alice@local $OFFLINE "PARVANE_AUTOPATCH=folder-title|Работа|Работа+дом@8,contact-name|bob@local|Бобби@9")
wait_log "$L1" "autopatch folder-title «Работа» → Работа\+дом" 40 && wait_log "$L1" "autopatch contact-name bob@local → Бобби \(ok\)" 20 \
  && ok "alice1 (без связи): папка переименована, своё имя bob задано" || bad "alice1: правки без связи не сделаны"
sleep 2; stop_pid "$P1"
P2=$(start_client "$A2" alice@local $OFFLINE "PARVANE_AUTOPATCH=folder-add|Работа|carol@local@8,contact-note|bob@local|сосед по даче@9")
wait_log "$L2" "autopatch folder-add «Работа» → carol@local" 40 && wait_log "$L2" "autopatch contact-note bob@local → сосед по даче \(ok\)" 20 \
  && ok "alice2 (без связи): carol в папке, заметка bob задана" || bad "alice2: правки без связи не сделаны"
sleep 2; stop_pid "$P2"

# ── обе в сети: правки дошли друг до друга, ни одна не потеряна ──────────────
# И «В избранное» у стикера (spec 035 T126, FR-075): alice1 отмечает стикер своего набора, alice2 (тот же набор на
# устройстве) видит его в «Избранном» — объект FAVED_STICKER журнала state.v2, общий id набора PACK-1 (pack-set-id.json)
SD="$SB/stickers"; mkdir -p "$SD/Котики"
python3 -c "import struct,zlib,sys
def ch(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
raw=b''.join(b'\x00'+b'\xff\x80\x00\xff'*8 for _ in range(8))
sys.stdout.buffer.write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',8,8,8,6,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b''))" \
  > "$SD/Котики/01-1f602.png"
DUMP="PARVANE_AUTOPATCH=dump|Работа|bob@local@40,dump|Работа|bob@local@70"
P1=$(start_client "$A1" alice@local "$DUMP,fave|Котики|01-1f602.png@50,faved|-|-@90" "PARVANE_STICKERS_DIR=$SD")
wait_log "$L1" "журнал личного состояния подключён" 90 || bad "alice1: журнал не подключён"
sleep 5
P2=$(start_client "$A2" alice@local "$DUMP,faved|-|-@100,faved|-|-@130,faved|-|-@160" "PARVANE_STICKERS_DIR=$SD")
wait_log "$L2" "журнал личного состояния подключён" 90 || bad "alice2: журнал не подключён"
want="autopatch dump папка «Работа\+дом» чаты \[bob@local carol@local\]; контакт bob@local имя «Бобби» заметка «сосед по даче»"
wait_log "$L2" "$want" 90 && ok "alice2: название папки alice1 и свой чат, своё имя alice1 и своя заметка — всё на месте" \
  || bad "alice2: потеряна правка ($(grep -a 'autopatch dump' "$L2" | tail -1 | sed 's/.*autopatch dump //'))"
wait_log "$L1" "$want" 90 && ok "alice1: чат и заметка alice2 пришли, свои правки на месте" \
  || bad "alice1: потеряна правка ($(grep -a 'autopatch dump' "$L1" | tail -1 | sed 's/.*autopatch dump //'))"

# PACK-1 (spec 036): ключ избранного — общий id набора (`h:<отпечаток содержимого>`) и имя файла манифеста
K='h:[A-Za-z0-9+/=]+/01-1f602\.png'
wait_log "$L1" "autopatch fave $K → в избранном" 90 && wait_log "$L1" "стикер 01-1f602\.png в избранного — записано в журнал" 60 \
  && ok "alice1: стикер своего набора — в избранном общим id набора, записано в журнал" || bad "alice1: стикер не добавлен в избранное"
wait_log "$L2" "autopatch faved \[$K\]" 180 && ok "alice2: стикер alice1 в «Избранном» (FAVED_STICKER, тот же общий id)" \
  || bad "alice2: избранное не пришло ($(grep -a 'autopatch faved' "$L2" | tail -1 | sed 's/.*autopatch faved //'))"
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"
stack_stop
finish "verify_state_patch"
