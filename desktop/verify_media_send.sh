#!/usr/bin/env bash
# Parvane — отправка МЕДИА из РЕАЛЬНОГО форка (Фаза 4a, исходящее медиа).
# alice-форк отправляет файл штатным путём tdesktop
#   FileLoadTask → Api::SendConfirmedFile → Parvane::MirrorOutgoingFile
# (blobcrypt → загрузка блоба cloud.blob.* по v2 + содержимое v2 с секретом
# capability собеседнику). Проверяем сторону СЕРВЕРА (приём на клиенте —
# verify_media_two_instances.sh):
#   1) форк залогинился и отправил медиа (лог «медиа отправлено … [E2E]», есть file_id);
#   2) имени файла нет ни в одной БД messenger (v1 и v2) — серверу не видно;
#   3) блоб в cloud — шифртекст (PVB2, правило BLOB-1): исходных байт в нём нет;
#   4) доступ к блобу — по секрету capability (CAP-1): в cloud.db-v2.db лежит только
#      SHA-256 секрета (blob_caps), грантов получателю (file_grants) нет.
# Стек поднимает сам (verify_lib.sh); нужен собранный бинарь.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-media-send}"
A="$SB/alice"; B="$SB/bob"
SRC="$SB/note.bin"
MARK="PARVANE MEDIA E2E"

# Тестовый блоб с нулевыми байтами (бинарная целостность на пути шифрования).
printf '%s \x00\x01\x02 payload %s' "$MARK" "$(date +%s)" > "$SRC"
SZ=$(stat -c%s "$SRC")
echo "файл: $SZ байт"

# Получатель обязан завести устройство и журнал устройств v2 ДО отправки:
# конверт адресуется по его журналу (без журнала отправка не состоится).
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "v2: готов" 90 || bad "bob не поднялся"
stop_pid "$PB"

PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSENDFILE="bob@local:$SRC")
LOG="$A/td/log.txt"
wait_log "$LOG" "Parvane: медиа отправлено" 90
sleep 1
stop_pid "$PA"

echo "── ALICE log.txt (Parvane) ──"
grep -aiE "Parvane: (login|autosendfile|медиа отправлено|ошибка отправки медиа)" "$LOG" 2>/dev/null || echo "(пусто)"
echo "─────────────────────────────"

grep -qa "Parvane: autosendfile → bob@local" "$LOG" && ok "форк прочитал файл (autosendfile)" || bad "autosendfile не сработал"
SENT_LINE=$(grep -a "Parvane: медиа отправлено" "$LOG" 2>/dev/null | tail -1)
[ -n "$SENT_LINE" ] && ok "медиа отправлено в шину" || bad "нет строки об отправке медиа"
printf '%s' "$SENT_LINE" | grep -q '\[E2E\]' && ok "отправка помечена [E2E]" || bad "отправка без [E2E]"
FILE_ID=$(printf '%s' "$SENT_LINE" | sed -n 's/.*(file \([0-9a-f-]\+\).*/\1/p')
[ -n "$FILE_ID" ] && ok "получен file_id: ${FILE_ID:0:8}…" || bad "file_id не извлечён"
grep -qaiE "Fatal|Unexpected in " "$LOG" && bad "фатальная ошибка в логе" || ok "без фатальных ошибок"

# ── сторона сервера ──
grep -qa "note.bin" "$SB"/messenger.db* && bad "имя файла видно серверу (messenger.db*)" || ok "имя файла серверу не видно"
if [ -n "$FILE_ID" ]; then
  BLOB="$SB/cloud-blob.bin"
  sqlite3 "$SB/cloud.db" "SELECT hex(data) FROM chunks WHERE file_id='$FILE_ID' ORDER BY chunk_index;" \
    | tr -d '\n' | xxd -r -p > "$BLOB"
  BSZ=$(stat -c%s "$BLOB" 2>/dev/null || echo 0)
  [ "$BSZ" -gt "$SZ" ] && ok "блоб в cloud есть ($BSZ байт > $SZ исходных: заголовок и теги AEAD)" || bad "блоб в cloud пуст или короче исходника ($BSZ)"
  grep -qa "$MARK" "$BLOB" && bad "в cloud лежит ОТКРЫТЫЙ файл (маркер найден)" || ok "cloud хранит шифртекст (исходных байт нет)"
  cmp -s "$SRC" "$BLOB" && bad "блоб в cloud равен исходнику" || ok "блоб в cloud ≠ исходник"
  OWNER=$(sqlite3 "$SB/cloud.db" "SELECT owner FROM files WHERE id='$FILE_ID';")
  [ "$OWNER" = "alice@local" ] && ok "владелец файла — alice" || bad "владелец файла: '$OWNER'"
  CAP=$(sqlite3 "$SB/cloud.db-v2.db" "SELECT length(cap_hash) FROM blob_caps WHERE file_id='$FILE_ID';")
  [ "$CAP" = "32" ] && ok "CAP-1: в cloud только SHA-256 секрета capability" || bad "CAP-1: хэша capability нет ('$CAP')"
  G=$(sqlite3 "$SB/cloud.db" "SELECT COUNT(*) FROM file_grants WHERE file_id='$FILE_ID';")
  [ "${G:-0}" = "0" ] && ok "CAP-1: грантов получателю нет (доступ только по секрету)" || bad "у блоба гранты: $G"
fi

stack_stop
finish "ОТПРАВКА МЕДИА"
