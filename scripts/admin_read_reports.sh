#!/usr/bin/env bash
# Жалобы пользователей администратору сервера (spec 024). Жалоба лежит в базе identity шифртекстом под
# открытым ключом администратора (`PARVANE_REPORT_PUBLIC_KEY`); закрытый ключ — только у администратора,
# вне сервера (`escrow_admin keygen <файл>` — отдельная пара, не ключ копии корня).
#
#   scripts/admin_read_reports.sh <файл ключа> [--done]
#
# Печатает неразобранные жалобы (номер, автор, время, JSON: причина, комментарий, на кого, сообщения).
# С `--done` помечает напечатанные разобранными (`done_ms`), и в следующий раз они не показываются.
#
# База identity v2:
#   по умолчанию — прод: ssh из backend/infra/deploy/.deploy.env, том parvane_db-identity;
#   PARVANE_IDENTITY_V2_DB=<файл> — локальная база (dev, сценарии).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="${1:?файл закрытого ключа администратора для жалоб}"
MARK_DONE="${2:-}"
[[ -r "$KEY_FILE" ]] || { echo "нет файла ключа: $KEY_FILE" >&2; exit 2; }

ADMIN="$ROOT/backend/target/debug/escrow_admin"
if [[ ! -x "$ADMIN" ]]; then
  cargo build --manifest-path "$ROOT/backend/Cargo.toml" -p parvane-protocol --bin escrow_admin
fi

if [[ -n "${PARVANE_IDENTITY_V2_DB:-}" ]]; then
  run_sql() { sqlite3 "$PARVANE_IDENTITY_V2_DB"; }
else
  DEPLOY_ENV="$ROOT/backend/infra/deploy/.deploy.env"
  [[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV"
  : "${PARVANE_DEPLOY_SSH_DEST:?задайте PARVANE_DEPLOY_SSH_DEST=user@host или PARVANE_IDENTITY_V2_DB}"
  run_sql() {
    ssh -p "${PARVANE_DEPLOY_SSH_PORT:-22}" -o BatchMode=yes "$PARVANE_DEPLOY_SSH_DEST" \
      "docker run --rm -i -v parvane_db-identity:/data alpine sh -c 'apk add -q sqlite && sqlite3 /data/identity.db-v2.db'"
  }
fi

ROWS="$(printf ".timeout 5000\n.separator '|'\nSELECT id, reporter, created_ms, hex(sealed) FROM reports WHERE done_ms IS NULL ORDER BY id;\n" | run_sql)"
if [[ -z "$ROWS" ]]; then
  echo "неразобранных жалоб нет"
  exit 0
fi

IDS=()
while IFS='|' read -r id reporter created sealed; do
  [[ "$id" =~ ^[0-9]+$ && "$reporter" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || continue
  echo "── жалоба №$id от $reporter, $(date -d "@$((created / 1000))" '+%Y-%m-%d %H:%M:%S %Z')"
  if "$ADMIN" open-report "$KEY_FILE" "$reporter" "$sealed"; then
    IDS+=("$id")
  else
    echo "   (не открылась — другой ключ администратора?)"
  fi
done <<<"$ROWS"

if [[ "$MARK_DONE" == "--done" && ${#IDS[@]} -gt 0 ]]; then
  printf ".timeout 5000\nUPDATE reports SET done_ms = CAST(strftime('%%s','now') AS INTEGER) * 1000 WHERE id IN (%s);\n" \
    "$(IFS=,; echo "${IDS[*]}")" | run_sql
  echo "помечено разобранными: ${#IDS[@]}"
fi
