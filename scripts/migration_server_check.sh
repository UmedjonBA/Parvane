#!/usr/bin/env bash
# Проверка переноса сервера «ничего не потеряно» (spec 035, T101, FR-061, FR-064; contracts/migration.md).
#
#   scripts/migration_server_check.sh <каталог баз до> <каталог бинарников шардов> [рабочий каталог]
#
# Базы до — копия баз шардов, наполненных НЫНЕШНИМ выпуском (синтетическая база сценария «всё понемногу» T006,
# `local-workdirs/spec035/seed-*/profiles/server`; копия прода — только T143 по слову пользователя, D3). Шаги:
#   1) копия баз → выгрузка «до» (`migration_audit_server.py --dump`, только дайджесты);
#   2) стек nats + identity + messenger + domains над копией: шарды на старте применяют миграции `migrations_v2`
#      в порядке принципа VII, messenger до приёма запросов пересчитывает окна членства (T104);
#   3) `messenger --migration-check` — окна членства согласны с журналами групп (0 расхождений);
#      `messenger --migration-status` — числа «устройства перенесли»;
#   4) стек остановлен → выгрузка «после» → `--strict`: ни одна таблица и ни одна запись журналов не потеряна.
# Код 0 — всё сошлось. Рабочий каталог (по умолчанию временный) после успеха удаляется.
set -euo pipefail
SRC=${1:?каталог баз до}
BIN=${2:?каталог бинарников (target/debug)}
HERE=$(cd "$(dirname "$0")" && pwd)
W=${3:-$(mktemp -d "${TMPDIR:-/tmp}/pv-migcheck.XXXXXX")}
mkdir -p "$W/before" "$W/run"
for f in "$SRC"/*.db "$SRC"/*.db-wal "$SRC"/*.db-shm "$SRC"/parvane.json; do
  [ -e "$f" ] || continue
  cp -p "$f" "$W/before/"
  cp -p "$f" "$W/run/"
done
python3 -I "$HERE/migration_audit_server.py" --dump "$W/before" -o "$W/before.jsonl"
echo "до: таблиц $(wc -l < "$W/before.jsonl")"

free_port() { python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
NATS_PORT=$(free_port)
export PARVANE_NATS_URL="nats://127.0.0.1:$NATS_PORT"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
nats-server -a 127.0.0.1 -p "$NATS_PORT" > "$W/nats.log" 2>&1 & PIDS+=($!)
sleep 0.5
WK="$W/run/parvane.json"
PARVANE_DB_PATH="$W/run/identity.db" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$WK" "$BIN/identity" > "$W/identity.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 600); do grep -q "Identity шард запущен" "$W/identity.log" 2>/dev/null && break; sleep 0.1; done
PARVANE_DB_PATH="$W/run/messenger.db" "$BIN/messenger" > "$W/messenger.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 1200); do grep -q "методы v2 подключены" "$W/messenger.log" 2>/dev/null && break; sleep 0.1; done
grep -q "методы v2 подключены" "$W/messenger.log" || { echo "messenger не поднялся"; tail -30 "$W/messenger.log"; exit 1; }
PARVANE_DB_PATH="$W/run/domains.db" "$BIN/domains" --migrate-only > "$W/domains.log" 2>&1
CHECK=$(PARVANE_DB_PATH="$W/run/messenger.db" "$BIN/messenger" --migration-check 2>"$W/check.log" | tail -1) || { echo "окна членства: $CHECK"; exit 1; }
echo "окна членства: $CHECK"
echo "перенесли: $(PARVANE_DB_PATH="$W/run/messenger.db" "$BIN/messenger" --migration-status 2>/dev/null | tail -1)"
cleanup
PIDS=()
python3 -I "$HERE/migration_audit_server.py" --dump "$W/run" -o "$W/after.jsonl"
python3 -I "$HERE/migration_audit_server.py" --strict "$W/before.jsonl" "$W/after.jsonl"
echo "ok: $W"
[ -z "${3:-}" ] && rm -rf "$W"
exit 0
