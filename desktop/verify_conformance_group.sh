#!/usr/bin/env bash
# Parvane desktop — CONFORMANCE GROUP-1 (conformance/sync-rules.json, spec 003).
# Сведения группы применяются по ревизии `version`, изменения доходят без
# перезагрузки и переживают рестарт:
#  1. alice создаёт группу с bob; владелец меняет описание/фото/права через
#     nats (group.setinfo / group.setperms) — bob получает нотис в инбокс и
#     пишет маркер «группа … обновлена (vN, нотис) about=… avatar=… perms=…».
#  2. рестарт bob тем же workdir — те же сведения приходят из group.list
#     («…, список) …») с той же ревизией.
#  3. устаревший нотис (v1 со старым именем), подсунутый вручную в инбокс bob,
#     НЕ применяется: маркер «нотис группы … устарел (v1 < vN), пропущен», имя
#     не откатилось.
#  4. удаление bob владельцем (group.removemember) — нотис removed снимает чат.
# Протокол v2 (по умолчанию, T135): сведения группы — подписанный журнал, ревизия
# — его версия. Те же четыре шага идут через клиент владельца (хуки экранов
# управления): изменения доходят без перезагрузки и переживают рестарт; v1-нотис,
# подсунутый в инбокс, к группе v2 не применяется вовсе (сведения — только из
# журнала); исключение снимает чат. PV_PROTO=v1 — прежний путь через шард.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-conformance-group}"
A="$SB/alice"; B="$SB/bob"
URL="nats://127.0.0.1:4222"
GNAME="Conf-Group-$$"
NATS="${NATS_CLI:-$HOME/.local/bin/nats}"

PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local")
wait_log "$A/td/log.txt" "E2E-устройство готово" 40 || bad "alice не поднялась"

GID=""
for _ in $(seq 1 40); do
  GID=$(group_gid "$A/td/log.txt" "$GNAME")
  [ -n "$GID" ] && break; sleep 1
done
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"

if is_v2; then
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
  # 3. v1-нотис о группе v2 (подделка сведений в обход журнала) не применяется
  STALE="{\"id\":\"00000000-0000-7000-8000-00000000dead\",\"from\":\"messenger\",\"ts\":0,\"token\":\"\",\"payload\":{\"group\":{\"group_id\":\"$GID\",\"version\":99,\"change\":\"info\",\"info\":{\"group_id\":\"$GID\",\"name\":\"STALE-NAME\",\"kind\":\"group\",\"created_by\":\"alice@local\",\"members\":[{\"address\":\"alice@local\",\"role\":\"owner\"},{\"address\":\"bob@local\",\"role\":\"owner\"}],\"version\":99}}}}"
  "$NATS" --server "$URL" pub "msg.user.bob@local" "$STALE" >/dev/null 2>&1
  sleep 6
  grep -a "STALE-NAME" "$B/td/log.txt" | grep -q "синтезирована\|обновлена" \
    && bad "GROUP-1: v1-нотис изменил сведения группы v2" || ok "GROUP-1: v1-нотис к группе v2 не применён"
  group_line "$B/td/log.txt" "$GID" | grep -q 'role=member' \
    && ok "GROUP-1: роль bob прежняя (member)" || bad "GROUP-1: роль bob изменилась после v1-нотиса"
  # 4. Исключение участника снимает чат
  stop_pid "$PA"
  PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOADMIN="$GNAME;remove:bob@local")
  wait_log "$A/td/log.txt" "админ-действие 'remove' над bob@local в $GID → ok" 40 && ok "исключение принято" || bad "исключение не принято"
  wait_log "$B/td/log.txt" "группа $GID снята" 30 \
    && ok "GROUP-1: исключённый участник снял группу" || bad "GROUP-1: исключение не обработано"
  # инварианты
  K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind NOT IN ('encrypted','group_encrypted');")
  [ "${K:-0}" = "0" ] && ok "на сервере только шифртекст" || bad "плейнтекст на сервере: $K"
  grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
  stop_pid "$PA"; stop_pid "$PB"; stack_stop
  finish "CONFORMANCE GROUP-1"
fi
wait_log "$B/td/log.txt" "группа $GID обновлена \(v0, список\)" 40 \
  && ok "bob получил группу из списка с ревизией v0" || bad "bob не получил группу из списка"

TOKEN=$("$NATS" --server "$URL" req identity.token.issue '{"user":"alice@local","password":"'"${PV_PASSWORD:-test-pass-2026}"'"}' 2>/dev/null \
  | grep -o '{.*}' | head -1 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
[ -n "$TOKEN" ] && ok "токен alice получен" || bad "нет токена alice"
req() { "$NATS" --server "$URL" req "$1" "$2" 2>/dev/null | grep -o '{.*}' | head -1; }

# 1. Описание, фото, права — нотис онлайн-участнику
R=$(req group.setinfo "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\",\"about\":\"описание конформанса\"}")
echo "$R" | grep -q '"ok":true' && ok "setinfo about принят ($R)" || bad "setinfo about отклонён: $R"
wait_log "$B/td/log.txt" "группа $GID обновлена \(v1, нотис\) about=описание конформанса" 20 \
  && ok "GROUP-1: описание дошло до bob нотисом без перезагрузки (v1)" || bad "GROUP-1: описание не дошло нотисом"
# один кадр инбокса — одно применение: раньше транспорт слал gateway'ю `sub` на
# каждый обработчик инбокса (6 NATS-подписок → каждый нотис ×6, 27 сен 2026)
sleep 3
N=$(grep -ac "группа $GID обновлена (v1, нотис)" "$B/td/log.txt")
[ "$N" = "1" ] && ok "нотис применён ровно один раз (одна подписка на инбокс)" || bad "нотис v1 применён $N раз (дубли подписки на инбокс)"
FID="019a0000-0000-7000-8000-00000000c0de"
R=$(req group.setinfo "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\",\"avatar_file_id\":\"$FID\"}")
echo "$R" | grep -q '"ok":true' && ok "setinfo avatar принят" || bad "setinfo avatar отклонён: $R"
wait_log "$B/td/log.txt" "группа $GID обновлена \(v2, нотис\) about=описание конформанса avatar=$FID" 20 \
  && ok "GROUP-1: file_id фото дошёл нотисом (v2)" || bad "GROUP-1: фото не дошло нотисом"
R=$(req group.setperms "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\",\"default_permissions\":{\"send_messages\":false}}")
echo "$R" | grep -q '"ok":true' && ok "setperms принят" || bad "setperms отклонён: $R"
wait_log "$B/td/log.txt" 'группа '"$GID"' обновлена \(v3, нотис\) .*"send_messages":false' 20 \
  && ok "GROUP-1: права по умолчанию дошли нотисом (v3)" || bad "GROUP-1: права не дошли нотисом"
grep -a "группа $GID обновлена (v3, нотис)" "$B/td/log.txt" | grep -q 'role=member' \
  && ok "роль bob в сведениях — member" || bad "роль bob не member"

# 2. Рестарт bob — итоговое состояние из group.list с той же ревизией
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "группа $GID обновлена \(v3, список\) about=описание конформанса avatar=$FID" 60 \
  && ok "GROUP-1: после рестарта сведения v3 пришли из списка" || bad "GROUP-1: после рестарта сведения не сошлись"

# 3. Устаревший нотис (v1, старое имя) не применяется
STALE="{\"id\":\"00000000-0000-7000-8000-00000000dead\",\"from\":\"messenger\",\"ts\":0,\"token\":\"\",\"payload\":{\"group\":{\"group_id\":\"$GID\",\"version\":1,\"change\":\"info\",\"info\":{\"group_id\":\"$GID\",\"name\":\"STALE-NAME\",\"kind\":\"group\",\"created_by\":\"alice@local\",\"members\":[{\"address\":\"alice@local\",\"role\":\"owner\"},{\"address\":\"bob@local\",\"role\":\"member\"}],\"about\":\"старое\",\"version\":1}}}}"
"$NATS" --server "$URL" pub "msg.user.bob@local" "$STALE" >/dev/null 2>&1
wait_log "$B/td/log.txt" "нотис группы $GID устарел \(v1 < v3\), пропущен" 20 \
  && ok "GROUP-1: устаревший нотис пропущен" || bad "GROUP-1: устаревший нотис не распознан"
grep -a "STALE-NAME" "$B/td/log.txt" | grep -q "синтезирована\|обновлена" \
  && bad "GROUP-1: устаревшее имя применилось" || ok "GROUP-1: имя не откатилось"

# 4. Удаление участника — нотис removed снимает чат у bob
R=$(req group.removemember "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\",\"member\":\"bob@local\"}")
echo "$R" | grep -q '"ok":true' && ok "removemember принят" || bad "removemember отклонён: $R"
wait_log "$B/td/log.txt" "группа $GID снята \(removed\)" 20 \
  && ok "GROUP-1: удалённый участник снял группу по нотису" || bad "GROUP-1: removed не обработан"

# инварианты
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind NOT IN ('encrypted','group_encrypted');")
[ "${K:-0}" = "0" ] && ok "на сервере только шифртекст" || bad "плейнтекст на сервере: $K"
V=$(sqlite3 "$SB/messenger.db" "SELECT version FROM groups WHERE id='$GID';")
[ "${V:-0}" = "4" ] && ok "ревизия группы на сервере = 4 (3 мутации + удаление участника)" || bad "ревизия на сервере $V"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "CONFORMANCE GROUP-1"
