#!/usr/bin/env bash
# Parvane desktop — ОТПРАВКА ГЕОЛОКАЦИИ (kind=location через шину, E2E):
# alice шлёт координаты bob'у; bob расшифровывает и получает location-content;
# на сервере — только шифртекст (kind=encrypted).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-loc}"
B="$SB/bob"; A="$SB/alice"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:метка-места" PARVANE_AUTOLOCATION="bob@local:55.751244,37.618423")
wait_log "$A/td/log.txt" "геолокация → bob@local \(55" 40 && ok "alice отправила геолокацию" || bad "alice не отправила геолокацию"
wait_log "$B/td/log.txt" "инъецировано" 60
# bob расшифровал location: пузырь с картой строится по координатам из
# расшифрованного content (preview в этом сценарии не поднят — «не собрана»
# тоже годится, важны координаты). Кэш расшифровки на диске зашифрован (P-13),
# читать его напрямую больше нельзя — заодно проверяем и это.
wait_log "$B/td/log.txt" "карта локации (не )?собрана 55\.7512,37\.6184" 40 \
  && ok "bob расшифровал location (пузырь карты с lat=55.7512 lon=37.6184)" || bad "bob не получил location"
DC="$B/td/tdata/parvane-dec-cache.jsonl"
if [ -s "$DC" ]; then
  head -c 5 "$DC" | grep -q '^PVSE1' && ! grep -qa '"kind":"location"' "$DC" \
    && ok "кэш расшифровки на диске зашифрован (PVSE1)" || bad "кэш расшифровки лежит открытым текстом"
else
  bad "нет кэша расшифровки у bob"
fi
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind='location';")
[ "${K:-0}" = "0" ] && ok "на сервере location скрыт (нет kind=location)" || bad "location на сервере открыт"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "ГЕОЛОКАЦИЯ"
