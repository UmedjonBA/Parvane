#!/usr/bin/env bash
# Онлайн-бэкап SQLite-баз шардов (sqlite3 .backup — консистентно при живых
# шардах, WAL учитывается). Использование:
#   scripts/backup_server_dbs.sh <dest-dir> [db-файлы...]
# Без явных файлов берёт все *.db из PARVANE_DB_DIR (или ./).

set -Eeuo pipefail

DEST="${1:?usage: backup_server_dbs.sh <dest-dir> [db files...]}"
shift || true

if ! command -v sqlite3 >/dev/null; then
  echo "sqlite3 не найден — установите пакет sqlite" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$DEST/$STAMP"
mkdir -p "$OUT_DIR"

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
  echo "OK: $db -> $out"
done

echo "Бэкап завершён: $OUT_DIR"
