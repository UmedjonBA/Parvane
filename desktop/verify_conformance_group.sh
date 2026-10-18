#!/usr/bin/env bash
# Parvane desktop — CONFORMANCE GROUP-1 (conformance/sync-rules.json, spec 003).
# Сведения группы v2 — подписанный журнал группы, ревизия — его версия
# (GROUP-3: только из журнала). Изменения владельца (хуки экранов управления)
# доходят до участника без перезагрузки и переживают рестарт:
#  1. alice создаёт группу с bob; описание, фото, права по умолчанию — bob пишет
#     маркер «группа … обновлена (vN, v2 …) about=… avatar=… perms=…», ревизия растёт;
#  2. рестарт bob тем же workdir — те же сведения, ревизия не откатилась;
#  3. исключение bob владельцем — чат у bob снят («группа … снята»).
# Подделать сведения нотисом в инбокс (прежний шаг 3) больше нельзя: прямого
# доступа к шине у клиентов нет, сведения приходят только записями журнала.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-conformance-group}"
A="$SB/alice"; B="$SB/bob"
GNAME="Conf-Group-$$"

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local")
wait_log "$A/td/log.txt" "v2: готов" 90 || bad "alice не поднялась"

GID=""
for _ in $(seq 1 40); do
  GID=$(group_gid "$A/td/log.txt" "$GNAME")
  [ -n "$GID" ] && break; sleep 1
done
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"

J='v[0-9]+, v2 [^)]*'
wait_log "$B/td/log.txt" "группа $GID обновлена \($J\)" 40 \
  && ok "bob получил группу из журнала" || bad "bob не получил группу"
PNG="$SB/group.png"
python3 - "$PNG" <<'PYPNG'
import struct, sys, zlib
w = h = 64
raw = b''.join(b'\x00' + bytes([42, 171, 238]) * w for _ in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
PYPNG
ver_of() { group_line "$1" "$GID" | sed -E 's/.*обновлена \(v([0-9]+),.*/\1/'; }
# 1. Описание, фото, права — без перезагрузки, ревизия растёт
V0=$(ver_of "$B/td/log.txt")
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINFO="$GNAME:about=описание конформанса;avatar=$PNG")
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' about → ok" 40 && ok "описание принято" || bad "описание не принято"
wait_log "$B/td/log.txt" "группа $GID обновлена \($J\) about=описание конформанса" 30 \
  && ok "GROUP-1: описание дошло до bob без перезагрузки" || bad "GROUP-1: описание не дошло"
wait_log "$A/td/log.txt" "AUTOGROUPINFO '$GNAME' avatar → ok" 40 && ok "фото принято" || bad "фото не принято"
wait_log "$B/td/log.txt" "группа $GID обновлена \($J\) about=описание конформанса avatar=[0-9a-f-]{36}" 30 \
  && ok "GROUP-1: file_id фото дошёл без перезагрузки" || bad "GROUP-1: фото не дошло"
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:send_messages=0")
wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 && ok "права приняты" || bad "права не приняты"
wait_log "$B/td/log.txt" 'группа '"$GID"' обновлена \('"$J"'\) .*"send_messages":false' 30 \
  && ok "GROUP-1: права по умолчанию дошли без перезагрузки" || bad "GROUP-1: права не дошли"
group_line "$B/td/log.txt" "$GID" | grep -q 'role=member' && ok "роль bob в сведениях — member" || bad "роль bob не member"
sleep 2
V3=$(ver_of "$B/td/log.txt")
[ "${V3:-0}" -ge $(( ${V0:-0} + 3 )) ] && ok "GROUP-1: ревизия выросла не меньше чем на три записи (v$V0 → v$V3)" || bad "GROUP-1: ревизия v$V0 → v$V3"
# 2. Рестарт bob — те же сведения, ревизия не откатилась
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" 'группа '"$GID"' обновлена \('"$J"'\) about=описание конформанса avatar=[0-9a-f-]{36} .*"send_messages":false' 60 \
  && ok "GROUP-1: после рестарта сведения на месте" || bad "GROUP-1: после рестарта сведения не сошлись"
sleep 3
V4=$(ver_of "$B/td/log.txt")
[ "${V4:-0}" -ge "${V3:-0}" ] && ok "GROUP-1: ревизия после рестарта не откатилась (v$V4)" || bad "GROUP-1: ревизия откатилась v$V3 → v$V4"
# 3. Исключение участника снимает чат
stop_pid "$PA"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOADMIN="$GNAME;remove:bob@local")
wait_log "$A/td/log.txt" "админ-действие 'remove' над bob@local в $GID → ok" 40 && ok "исключение принято" || bad "исключение не принято"
wait_log "$B/td/log.txt" "группа $GID снята" 30 \
  && ok "GROUP-1: исключённый участник снял группу" || bad "GROUP-1: исключение не обработано"
# инварианты: на сервере только шифртекст (текст группы не задаём — сверяем описание)
grep -qa "описание конформанса" "$SB"/messenger.db* && bad "описание группы лежит на сервере открыто" \
  || ok "сведения группы на сервере не видны открыто"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "CONFORMANCE GROUP-1"
