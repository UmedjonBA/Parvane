#!/usr/bin/env bash
# Онлайн-бэкап SQLite-баз шардов (sqlite3 .backup — консистентно при живых
# шардах, WAL учитывается). Использование:
#   scripts/backup_server_dbs.sh <dest-dir> [db-файлы...]
# Без явных файлов берёт все *.db из PARVANE_DB_DIR (или ./).

set -Eeuo pipefail

# P-11: бэкапы содержат хэши паролей и переписку (шифртекст + метаданные) —
# файлы только для владельца; при заданном получателе age — шифруем и
# удаляем открытую копию. Ключи подписи JWT/VAPID в БД больше не лежат
# (identity-jwt-ed25519.pem, push-vapid-p256.pem — бэкапить отдельно).
#   PARVANE_BACKUP_AGE_RECIPIENT  публичный ключ age (age1...) или путь к
#                                 файлу с получателями (-R); пусто = без шифра
umask 077

DEST="${1:?usage: backup_server_dbs.sh <dest-dir> [db files...]}"
shift || true

if ! command -v sqlite3 >/dev/null; then
  echo "sqlite3 не найден — установите пакет sqlite" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$DEST/$STAMP"
mkdir -p "$OUT_DIR"
chmod 700 "$DEST" "$OUT_DIR"

AGE_RECIPIENT="${PARVANE_BACKUP_AGE_RECIPIENT:-}"
if [[ -n "$AGE_RECIPIENT" ]] && ! command -v age >/dev/null; then
  echo "PARVANE_BACKUP_AGE_RECIPIENT задан, но age не найден — установите age" >&2
  exit 1
fi

declare -a DBS=()
if (( $# > 0 )); then
  DBS=("$@")
else
  SRC_DIR="${PARVANE_DB_DIR:-.}"
  while IFS= read -r -d '' db; do
    DBS+=("$db")
  done < <(find "$SRC_DIR" -maxdepth 2 -name '*.db' -type f -print0)
fi

if (( ${#DBS[@]} == 0 )); then
  echo "Не найдено ни одной *.db (PARVANE_DB_DIR=${PARVANE_DB_DIR:-.})" >&2
  exit 1
fi

for db in "${DBS[@]}"; do
  name="$(basename "$db")"
  out="$OUT_DIR/$name"
  sqlite3 "$db" ".backup '$out'"
  # Верификация: бэкап открывается и целостен
  if [[ "$(sqlite3 "$out" 'PRAGMA integrity_check;')" != "ok" ]]; then
    echo "ПОВРЕЖДЁННЫЙ бэкап: $out" >&2
    exit 1
  fi
  chmod 600 "$out"
  if [[ -n "$AGE_RECIPIENT" ]]; then
    if [[ -f "$AGE_RECIPIENT" ]]; then
      age -R "$AGE_RECIPIENT" -o "$out.age" "$out"
    else
      age -r "$AGE_RECIPIENT" -o "$out.age" "$out"
    fi
    chmod 600 "$out.age"
    rm -f "$out"
    echo "OK: $db -> $out.age (age)"
  else
    echo "OK: $db -> $out"
  fi
done

echo "Бэкап завершён: $OUT_DIR"
