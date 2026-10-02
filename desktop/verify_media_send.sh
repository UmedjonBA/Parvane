#!/usr/bin/env bash
# Parvane — отправка МЕДИА из РЕАЛЬНОГО форка (Фаза 4a, исходящее медиа).
# alice-форк отправляет файл штатным путём tdesktop
#   FileLoadTask → Api::SendConfirmedFile → Parvane::MirrorOutgoingFile
# (blobcrypt → upload в cloud чанками + msg.chat.send с E2E-конвертом).
# Проверяем сторону СЕРВЕРА (приём на клиенте — verify_media_two_instances.sh):
#   1) форк залогинился и отправил медиа (лог «медиа отправлено … [E2E]», есть file_id);
#   2) в messenger для bob ровно одно сообщение: kind=encrypted, sealed
#      (from_user пуст) — kind=file и имя файла серверу не видны;
#   3) блоб в cloud — шифртекст (PVB2, правило BLOB-1): исходных байт в нём нет,
#      доступ к файлу выдан отправителю и получателю (file_grants).
# До E2E-медиа сценарий сверял открытый kind=file в msg.sync и побайтовое
# равенство блоба в cloud исходнику — после ревью безопасности это было бы
# как раз дефектом.
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

# Получатель обязан опубликовать устройство ДО отправки: sealed-конверт и ключ
# блоба шифруются под его prekeys (без них отправка не состоится).
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
stop_pid "$PB"

PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSENDFILE="bob@local:$SRC")
LOG="$A/td/log.txt"
wait_log "$LOG" "Parvane: медиа отправлено" 40
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
ROWS=$(sqlite3 "$SB/messenger.db" "SELECT kind || '|' || from_user FROM messages WHERE to_user='bob@local';")
[ "$ROWS" = "encrypted|" ] && ok "messenger: одно сообщение для bob — kind=encrypted, sealed (from пуст)" \
  || bad "messenger: ожидалось одно encrypted-сообщение без from, получено: '$ROWS'"
grep -qa "note.bin" "$SB/messenger.db" && bad "имя файла видно серверу (messenger.db)" || ok "имя файла серверу не видно"
if [ -n "$FILE_ID" ]; then
  BLOB="$SB/cloud-blob.bin"
  sqlite3 "$SB/cloud.db" "SELECT hex(data) FROM chunks WHERE file_id='$FILE_ID' ORDER BY chunk_index;" \
    | tr -d '\n' | xxd -r -p > "$BLOB"
  BSZ=$(stat -c%s "$BLOB" 2>/dev/null || echo 0)
  [ "$BSZ" -gt "$SZ" ] && ok "блоб в cloud есть ($BSZ байт > $SZ исходных: заголовок и теги AEAD)" || bad "блоб в cloud пуст или короче исходника ($BSZ)"
  grep -qa "$MARK" "$BLOB" && bad "в cloud лежит ОТКРЫТЫЙ файл (маркер найден)" || ok "cloud хранит шифртекст (исходных байт нет)"
  cmp -s "$SRC" "$BLOB" && bad "блоб в cloud равен исходнику" || ok "блоб в cloud ≠ исходник"
  G=$(sqlite3 "$SB/cloud.db" "SELECT group_concat(principal, ',') FROM (SELECT principal FROM file_grants WHERE file_id='$FILE_ID' ORDER BY principal);")
  OWNER=$(sqlite3 "$SB/cloud.db" "SELECT owner FROM files WHERE id='$FILE_ID';")
  [ "$OWNER" = "alice@local" ] && ok "владелец файла — alice" || bad "владелец файла: '$OWNER'"
  echo "$G" | grep -q "bob@local" && ok "доступ к файлу выдан получателю ($G)" || bad "получателю не выдан доступ к файлу ($G)"
fi

stack_stop
finish "ОТПРАВКА МЕДИА"
