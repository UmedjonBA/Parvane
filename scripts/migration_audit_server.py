#!/usr/bin/env python3
"""Сверка баз шардов «ничего не потеряно» (spec 035, T007/T008; contracts/migration.md).

  migration_audit_server.py --dump <каталог с *.db> [-o out.jsonl]
      выгрузка: по строке на таблицу каждой базы —
      {"kind": "sqlite:<база>", "key": "<таблица>", "digest": "<sha256 строк по первичному ключу>",
       "pk_digest": "<sha256 только первичных ключей>", "rows": N}
      Базы открываются только на чтение (`mode=ro`), WAL читается как есть — можно снимать с живого стека.
  migration_audit_server.py <before.jsonl | каталог> <after.jsonl | каталог>
      сравнение двух выгрузок: потеряно / изменено / добавлено по таблицам (только счётчики и имена, без содержимого);
      код 1, если таблица пропала или в ней стало меньше строк.

  migration_audit_server.py --strict <до> <после>
      то же + инварианты переноса (T101, contracts/migration.md): ни одна запись журналов (`group_state_log`,
      `user_state_log`, `user_history_log`, `inbox_log`, журналы domains, блобы cloud) не потеряна и не добавлена —
      число строк и дайджест первичных ключей те же (меняться могут только колонки, которые добавили миграции);
      прочие таблицы — не меньше строк. Окна членства против журналов групп сверяет `messenger --migration-check`
      (нужны NATS и identity: подписанты записей), прогон целиком — `scripts/migration_server_check.sh`.

Содержимое строк в выгрузку не попадает — только дайджесты и числа (копия баз прода, D3, не должна утечь в отчёт).
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys


def canonical(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"hex": bytes(value).hex()}
    return value


def table_names(conn):
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    return [r[0] for r in rows]


def primary_key(conn, table):
    cols = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    pk = sorted((c[5], c[1]) for c in cols if c[5])
    return [name for _, name in pk], [c[1] for c in cols]


def dump_db(path):
    name = os.path.basename(path)
    if name.endswith(".db"):
        name = name[:-3]
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for table in table_names(conn):
            pk, cols = primary_key(conn, table)
            order = pk or cols
            quoted = ", ".join(f'"{c}"' for c in order)
            full = hashlib.sha256()
            keys = hashlib.sha256()
            count = 0
            for row in conn.execute(f'SELECT {", ".join(chr(34) + c + chr(34) for c in cols)} FROM "{table}" '
                                    f'ORDER BY {quoted}'):
                record = dict(zip(cols, (canonical(v) for v in row)))
                full.update(json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())
                full.update(b"\n")
                keys.update(json.dumps([record[c] for c in order], ensure_ascii=False, separators=(",", ":")).encode())
                keys.update(b"\n")
                count += 1
            yield {"kind": f"sqlite:{name}", "key": table, "digest": full.hexdigest(), "pk_digest": keys.hexdigest(),
                   "rows": count}
    finally:
        conn.close()


def dump_dir(directory):
    lines = []
    for entry in sorted(os.listdir(directory)):
        if entry.endswith(".db"):
            lines.extend(dump_db(os.path.join(directory, entry)))
    return lines


def load(source):
    if os.path.isdir(source):
        return dump_dir(source)
    with open(source, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


# Журналы и блобы: записи не теряются и не появляются при переносе (миграции добавляют только колонки/таблицы)
LOG_TABLES = {
    "group_state_log", "user_state_log", "user_history_log", "inbox_log", "user_state_log_v2",
    "container_log", "container_grant_log", "container_snapshots", "files", "chunks", "blob_caps", "link_blobs",
}
# Кэши со сроком, которые шард сам чистит на старте и по таймеру (не данные пользователя): уменьшение числа строк —
# плановая чистка, не потеря. spent_tokens — потраченные слепые жетоны (`gc_spent`, 3 сут); link_offers/link_grants —
# незавершённые привязки устройств (identity `link.rs`, срок предложения); public_group_messages — окно ленты публичной
# группы. Найдено T143 на копии прода: 2 жетона старше 3 сут удалены при старте (11 ноя 2026)
TTL_TABLES = {"spent_tokens", "link_offers", "link_grants", "public_group_messages"}


def strict_check(before, after):
    """Инварианты переноса: журналы — те же первичные ключи; иначе — список нарушений."""
    b = {(l["kind"], l["key"]): l for l in before}
    a = {(l["kind"], l["key"]): l for l in after}
    bad = []
    for key, lb in sorted(b.items()):
        la = a.get(key)
        if la is None:
            bad.append(f"таблица пропала: {key[0]} {key[1]}")
            continue
        if key[1] in LOG_TABLES and (la["rows"] != lb["rows"] or la.get("pk_digest") != lb.get("pk_digest")):
            bad.append(f"журнал изменил состав записей: {key[0]} {key[1]} ({lb['rows']} → {la['rows']})")
        elif la["rows"] < lb["rows"] and key[1] not in TTL_TABLES:
            bad.append(f"меньше строк: {key[0]} {key[1]} ({lb['rows']} → {la['rows']})")
    for line in bad:
        print(f"НАРУШЕНИЕ {line}")
    print(f"инварианты: нарушений {len(bad)}")
    return bad


def compare(before, after):
    b = {(l["kind"], l["key"]): l for l in before}
    a = {(l["kind"], l["key"]): l for l in after}
    lost = sorted(set(b) - set(a))
    added = sorted(set(a) - set(b))
    changed, shrunk = [], []
    for key in sorted(set(a) & set(b)):
        if a[key]["digest"] != b[key]["digest"]:
            changed.append((key, b[key]["rows"], a[key]["rows"]))
            if a[key]["rows"] < b[key]["rows"] and key[1] not in TTL_TABLES:
                shrunk.append(key)
    print(f"таблиц до: {len(b)}, после: {len(a)}")
    for kind, table in lost:
        print(f"ПОТЕРЯНА таблица {kind} {table} ({b[(kind, table)]['rows']} строк)")
    for kind, table in added:
        print(f"добавлена таблица {kind} {table} ({a[(kind, table)]['rows']} строк)")
    for (kind, table), rb, ra in changed:
        mark = "изменена" if ra >= rb else ("меньше строк (кэш со сроком)" if table in TTL_TABLES else "МЕНЬШЕ СТРОК")
        print(f"{mark} {kind} {table}: {rb} → {ra}")
    print(f"итог: потеряно таблиц {len(lost)}, изменено {len(changed)} (из них меньше строк {len(shrunk)}), "
          f"добавлено {len(added)}")
    return 1 if lost or shrunk else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dump", metavar="DIR", help="каталог с базами *.db")
    parser.add_argument("-o", "--out", help="файл выгрузки (по умолчанию stdout)")
    parser.add_argument("--strict", action="store_true", help="плюс инварианты журналов (T101)")
    parser.add_argument("sources", nargs="*", help="две выгрузки (или каталога) для сравнения")
    args = parser.parse_args()
    if args.dump:
        lines = dump_dir(args.dump)
        text = "".join(json.dumps(l, ensure_ascii=False, separators=(",", ":")) + "\n" for l in lines)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text)
        else:
            sys.stdout.write(text)
        return 0
    if len(args.sources) != 2:
        parser.error("нужны --dump DIR или две выгрузки для сравнения")
    before, after = load(args.sources[0]), load(args.sources[1])
    rc = compare(before, after)
    if args.strict and strict_check(before, after):
        rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
