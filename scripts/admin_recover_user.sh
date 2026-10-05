#!/usr/bin/env bash
# Пользователь потерял ключ восстановления (а с ним — возможность войти на новом
# устройстве или сменить ключ подписи устройств). Администратор СВОИМ закрытым
# ключом (он хранится вне сервера, см. `escrow_admin keygen`) открывает копию
# корня пользователя и выписывает новый ключ восстановления: ключ печатается
# на экран — передать пользователю лично; на сервер уходит только новая копия
# корня под этим ключом (шифртекст).
#
#   scripts/admin_recover_user.sh <адрес пользователя> <файл ключа администратора>
#
# База identity v2:
#   по умолчанию — прод: ssh из backend/infra/deploy/.deploy.env, том parvane_db-identity;
#   PARVANE_IDENTITY_V2_DB=<файл> — локальная база (dev, сценарии).
# Пользователь затем вводит новый ключ: Настройки → Устройства → «Ввести ключ
# восстановления». Копия есть только у тех, чей клиент её отправил (корень создан
# или ключ восстановления вводился после включения PARVANE_ESCROW_PUBLIC_KEY).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_ADDR="${1:?адрес пользователя (ник@домен)}"
KEY_FILE="${2:?файл закрытого ключа администратора}"
[[ "$USER_ADDR" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || { echo "негодный адрес: $USER_ADDR" >&2; exit 2; }
[[ -r "$KEY_FILE" ]] || { echo "нет файла ключа: $KEY_FILE" >&2; exit 2; }

ADMIN="$ROOT/backend/target/debug/escrow_admin"
if [[ ! -x "$ADMIN" ]]; then
  cargo build --manifest-path "$ROOT/backend/Cargo.toml" -p parvane-protocol --bin escrow_admin
fi

# Один запрос к базе identity v2: SQL — со стандартного ввода
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

ESCROW_HEX="$(printf ".timeout 5000\nSELECT hex(escrow) FROM root_escrow WHERE user = '%s';\n" "$USER_ADDR" | run_sql)"
if [[ -z "$ESCROW_HEX" ]]; then
  echo "у $USER_ADDR нет копии корня для администратора: клиент её не отправлял." >&2
  echo "Остаётся сброс личности на устройстве пользователя (прежняя переписка этим устройством не читается)." >&2
  exit 1
fi

# Новый ключ восстановления и копия корня под ним; ключ — только на экран
OUT="$("$ADMIN" recover "$KEY_FILE" "$USER_ADDR" "$ESCROW_HEX")"
RECOVERY_KEY="$(sed -n 's/^recovery_key=//p' <<<"$OUT")"
BACKUP_HEX="$(sed -n 's/^backup=//p' <<<"$OUT")"
[[ -n "$RECOVERY_KEY" && "$BACKUP_HEX" =~ ^[0-9a-f]+$ ]] || { echo "escrow_admin не вернул ключ и копию" >&2; exit 1; }

printf ".timeout 5000\nINSERT OR REPLACE INTO root_backup (user, backup, updated_at) VALUES ('%s', X'%s', CAST(strftime('%%s','now') AS INTEGER));\n" \
  "$USER_ADDR" "$BACKUP_HEX" | run_sql

echo "Новый ключ восстановления для $USER_ADDR (передать пользователю лично, нигде не сохранять):"
echo "$RECOVERY_KEY"
