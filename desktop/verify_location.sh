#!/usr/bin/env bash
# Parvane desktop — ОТПРАВКА ГЕОЛОКАЦИИ (kind=location через шину, E2E):
# alice шлёт координаты bob'у; bob расшифровывает и получает location-content;
# на сервере — только шифртекст.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-loc}"
B="$SB/bob"; A="$SB/alice"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:метка-места" PARVANE_AUTOLOCATION="bob@local:55.751244,37.618423")
wait_log "$A/td/log.txt" "геолокация → bob@local \(55" 40 && ok "alice отправила геолокацию" || bad "alice не отправила геолокацию"
wait_log "$B/td/log.txt" "инъецировано" 60
# bob расшифровал location: пузырь с картой строится по координатам из
# расшифрованного content (тайлов в кэше preview нет, а OSM может быть недоступен —
# «не собрана» тоже годится, важны координаты). Кэш расшифровки на диске зашифрован (P-13),
# читать его напрямую больше нельзя — заодно проверяем и это.
wait_log "$B/td/log.txt" "карта локации (не )?собрана 55\.7512,37\.6184" 40 \
  && ok "bob расшифровал location (пузырь карты с lat=55.7512 lon=37.6184)" || bad "bob не получил location"
# расшифрованное лежит в журнале истории (построчно запечатан PVSE1)
DC="$B/td/tdata/parvane-history-bob@local.jsonl"
if [ -s "$DC" ]; then
  head -c 5 "$DC" | grep -q '^PVSE1' && ! grep -qa -e '"kind":"location"' -e '55\.7512' "$DC" \
    && ok "расшифрованное на диске зашифровано (PVSE1)" || bad "расшифрованное лежит на диске открытым текстом"
else
  bad "нет расшифрованного на диске у bob ($DC)"
fi
grep -qa -e '"location"' -e '55\.7512' "$SB"/messenger.db* && bad "location на сервере открыт" \
  || ok "на сервере location скрыт (только шифртекст)"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "ГЕОЛОКАЦИЯ"
