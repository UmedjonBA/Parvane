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
# bob расшифровал location: content kind=location в кэше расшифровки
sleep 3
if python3 - "$B/td/tdata/parvane-dec-cache.jsonl" <<'PY'
import sys, json
found=False
for l in open(sys.argv[1]):
    l=l.strip()
    if not l: continue
    inner=json.loads(json.loads(l)["inner"]) if '"inner"' in l else {}
    c=inner.get("content",{})
    if c.get("kind")=="location" and abs(c.get("lat",0)-55.751244)<1e-4:
        found=True
sys.exit(0 if found else 1)
PY
then ok "bob расшифровал location (lat=55.75 в кэше)"; else bad "bob не получил location"; fi
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind='location';")
[ "${K:-0}" = "0" ] && ok "на сервере location скрыт (нет kind=location)" || bad "location на сервере открыт"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "ГЕОЛОКАЦИЯ"
