#!/usr/bin/env bash
# Чистка прода от тестовых аккаунтов дыма (`scripts/e2e_web_prod_v2_smoke.mjs` заводит
# по два на прогон: smoke-a-<суффикс>, smoke-b-<суффикс>; проверка «Плана» на проде —
# smoke-plan-a/b-<суффикс>). Удаляет ТОЛЬКО аккаунты с
# именем строго такого вида и всё, что им принадлежит, во всех базах шардов: учётные
# записи и устройства (identity v1/v2), инбоксы и личное состояние, группы, в которых
# нет никого, кроме них, их файлы, подписки push.
#
#   scripts/admin_purge_test_accounts.sh            — показать, что будет удалено
#   scripts/admin_purge_test_accounts.sh --apply    — снять бэкап и удалить
#
# Сервер — из backend/infra/deploy/.deploy.env. Шарды не останавливаются (SQLite WAL).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
source "$ROOT/backend/infra/deploy/.deploy.env"
: "${PARVANE_DEPLOY_SSH_DEST:?}" "${PARVANE_DEPLOY_PUBLIC_HOST:?}"
SSH=(ssh -p "${PARVANE_DEPLOY_SSH_PORT:-22}" -o BatchMode=yes "$PARVANE_DEPLOY_SSH_DEST")
DOMAIN="${PARVANE_PURGE_DOMAIN:-$PARVANE_DEPLOY_PUBLIC_HOST}"
NAME_RE="^smoke-(plan-)?[ab]-[a-z0-9]{6,12}@${DOMAIN//./\\.}$"

# SQL со стандартного ввода в базу шарда
sql() {  # sql <шард> <файл базы>
  "${SSH[@]}" "docker run --rm -i -v parvane_db-$1:/data alpine sh -c 'apk add -q sqlite && sqlite3 -cmd \".timeout 15000\" /data/$2'"
}

USERS="$(printf "SELECT username FROM users WHERE username LIKE 'smoke-a-%%@%s' OR username LIKE 'smoke-b-%%@%s' OR username LIKE 'smoke-plan-a-%%@%s' OR username LIKE 'smoke-plan-b-%%@%s';\n" "$DOMAIN" "$DOMAIN" "$DOMAIN" "$DOMAIN" | sql identity identity.db)"
if [[ -z "$USERS" ]]; then echo "тестовых аккаунтов нет"; exit 0; fi
while IFS= read -r user; do
  [[ "$user" =~ $NAME_RE ]] || { echo "ОТКАЗ: «$user» не похож на аккаунт дыма — ничего не удалено" >&2; exit 1; }
done <<<"$USERS"
COUNT="$(wc -l <<<"$USERS")"
echo "аккаунтов дыма: $COUNT"; sed 's/^/  /' <<<"$USERS"

# Временная таблица с адресами — в начале каждого пакета запросов
TEMP="CREATE TEMP TABLE t(u TEXT PRIMARY KEY);"
while IFS= read -r user; do TEMP+=" INSERT INTO t VALUES('$user');"; done <<<"$USERS"

# Ключи инбоксов v2: hex(SHA-256("parvane/v2/inbox\0" ‖ адрес ‖ "\0" ‖ device_id))[..32]
DEVICES="$(printf "%s\nSELECT user || ' ' || device_id FROM device_state WHERE user IN (SELECT u FROM t);\n" "$TEMP" | sql identity identity.db-v2.db)"
INBOX_IN="$(python3 -c '
import hashlib, sys
keys = []
for line in sys.stdin.read().splitlines():
    user, device = line.split(" ", 1)
    digest = hashlib.sha256(b"parvane/v2/inbox\0" + user.encode() + b"\0" + device.encode()).digest()
    keys.append("\x27" + digest[:16].hex() + "\x27")
print(",".join(keys) or "\x27\x27")
' <<<"$DEVICES")"

# Группы v2, где нет никого, кроме аккаунтов дыма
GROUPS_V2="SELECT group_id FROM group_members_v2 GROUP BY group_id HAVING SUM(member NOT IN (SELECT u FROM t)) = 0"
# Группы v1, созданные аккаунтом дыма и без посторонних участников
# База, созданная после удаления v1 (чистый деплой 10 окт 2026), таблиц групп v1 не имеет
if [[ "$(echo "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='groups';" | sql messenger messenger.db)" == 1 ]]; then
  GROUPS_V1="SELECT id FROM groups WHERE created_by IN (SELECT u FROM t) AND id NOT IN (SELECT group_id FROM group_members WHERE member NOT IN (SELECT u FROM t))"
else
  GROUPS_V1="SELECT NULL WHERE 0"
fi
FILES="SELECT id FROM files WHERE owner IN (SELECT u FROM t)"

IDENTITY_V1=(
  "users|username IN (SELECT u FROM t)"
  "device_keys|username IN (SELECT u FROM t)"
  "one_time_prekeys|username IN (SELECT u FROM t)"
  "email_codes|username IN (SELECT u FROM t)"
  "link_offers|username IN (SELECT u FROM t)"
  "link_grants|username IN (SELECT u FROM t)"
  "revoked_devices|username IN (SELECT u FROM t)"
  "telegram_links|username IN (SELECT u FROM t)"
  "login_links|username IN (SELECT u FROM t)"
  "trusted_devices|username IN (SELECT u FROM t)"
  "device_labels|username IN (SELECT u FROM t)"
)
IDENTITY_V2=(
  "device_log|user IN (SELECT u FROM t)" "device_log_archive|user IN (SELECT u FROM t)"
  "device_state|user IN (SELECT u FROM t)" "one_time_keys|user IN (SELECT u FROM t)"
  "fallback_keys|user IN (SELECT u FROM t)" "delivery_keys|user IN (SELECT u FROM t)"
  "privacy|user IN (SELECT u FROM t)" "token_issuance|user IN (SELECT u FROM t)"
  "device_key_claims|user IN (SELECT u FROM t)" "root_backup|user IN (SELECT u FROM t)"
  "root_escrow|user IN (SELECT u FROM t)"
)
MESSENGER_V1=(
  "message_device_copies|message_id IN (SELECT id FROM messages WHERE to_user IN (SELECT u FROM t) OR sender_user IN (SELECT u FROM t) OR to_user IN ($GROUPS_V1))"
  "read_receipts|reader IN (SELECT u FROM t)"
  "reactions|reactor IN (SELECT u FROM t)"
  "hidden_messages|user IN (SELECT u FROM t)"
  "inbox_queue|recipient IN (SELECT u FROM t)"
  "messages|to_user IN (SELECT u FROM t) OR sender_user IN (SELECT u FROM t) OR to_user IN ($GROUPS_V1)"
  "group_invites|group_id IN ($GROUPS_V1)"
  "group_join_requests|group_id IN ($GROUPS_V1) OR member IN (SELECT u FROM t)"
  "group_members|group_id IN ($GROUPS_V1) OR member IN (SELECT u FROM t)"
  "groups|created_by IN (SELECT u FROM t) AND id NOT IN (SELECT group_id FROM group_members)"
  "user_settings|user IN (SELECT u FROM t)"
)
MESSENGER_V2=(
  "inbox_log|device IN ($INBOX_IN)" "inbox_device|device IN ($INBOX_IN)"
  "user_state_log|user IN (SELECT u FROM t)" "user_state_head|user IN (SELECT u FROM t)"
  "group_state_log|group_id IN (SELECT group_id FROM g)" "group_links_v2|group_id IN (SELECT group_id FROM g)"
  "group_join_requests_v2|group_id IN (SELECT group_id FROM g) OR user IN (SELECT u FROM t)"
  "group_envelope_nonce|group_id IN (SELECT group_id FROM g)"
  "group_members_v2|group_id IN (SELECT group_id FROM g) OR member IN (SELECT u FROM t)"
)
CLOUD_V1=(
  "chunks|file_id IN ($FILES)" "file_grants|file_id IN ($FILES) OR principal IN (SELECT u FROM t)"
  "uploads|owner IN (SELECT u FROM t)" "files|owner IN (SELECT u FROM t)"
)
PUSH_V1=("push_subscriptions|user IN (SELECT u FROM t)")
PUSH_V2=("wake_registrations|user IN (SELECT u FROM t)")

# Пакет запросов: счётчики (dry-run) либо удаление одной транзакцией
batch() {  # batch <пролог> <таблица|условие>…
  local prologue="$1"; shift
  local out="$prologue"$'\n'
  (( APPLY )) && out+="BEGIN IMMEDIATE;"$'\n'
  for item in "$@"; do
    local table="${item%%|*}" where="${item#*|}"
    if (( APPLY )); then out+="DELETE FROM $table WHERE $where; SELECT '$table', changes();"$'\n'
    else out+="SELECT '$table', COUNT(*) FROM $table WHERE $where;"$'\n'; fi
  done
  (( APPLY )) && out+="COMMIT;"$'\n'
  printf '%s' "$out"
}
run() {  # run <шард> <база> <пролог> <пункты…>
  local shard="$1" db="$2" prologue="$3"; shift 3
  echo "== $db"
  # Только существующие таблицы: в свежей базе таблиц прежних версий нет
  local tables items=() item
  tables="$(echo "SELECT name FROM sqlite_master WHERE type='table';" | sql "$shard" "$db")"
  for item in "$@"; do
    grep -qx -- "${item%%|*}" <<<"$tables" && items+=("$item")
  done
  (( ${#items[@]} )) || return 0
  batch "$prologue" "${items[@]}" | sql "$shard" "$db" | awk -F'|' '$2 != 0 { printf "  %-24s %s\n", $1, $2 }'
}

if (( APPLY )); then
  echo "== бэкап перед удалением"
  "${SSH[@]}" 'cd ~/parvane && ./backup.sh | wc -l'
fi
G_PROLOGUE="$TEMP CREATE TEMP TABLE g AS $GROUPS_V2;"
# blob_caps — по файлам аккаунтов: список id берём из cloud.db до удаления файлов
FILE_IDS="$(printf "%s\nSELECT quote(id) FROM files WHERE owner IN (SELECT u FROM t);\n" "$TEMP" | sql cloud cloud.db | paste -sd, -)"
run messenger messenger.db-v2.db "$G_PROLOGUE" "${MESSENGER_V2[@]}"
run messenger messenger.db "$TEMP" "${MESSENGER_V1[@]}"
run cloud cloud.db-v2.db "" "blob_caps|file_id IN (${FILE_IDS:-''})"
run cloud cloud.db "$TEMP" "${CLOUD_V1[@]}"
run push push.db "$TEMP" "${PUSH_V1[@]}"
run push push.db-v2.db "$TEMP" "${PUSH_V2[@]}"
run identity identity.db-v2.db "$TEMP" "${IDENTITY_V2[@]}"
run identity identity.db "$TEMP" "${IDENTITY_V1[@]}"
if (( APPLY )); then echo "удалено аккаунтов: $COUNT"; else echo "это был просмотр; для удаления — с ключом --apply"; fi
