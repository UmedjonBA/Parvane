#!/usr/bin/env python3
"""Сверка выгрузок клиента «ничего не потеряно» (spec 035, T105, FR-064; contracts/migration.md).

  migration_audit_diff.py <audit-before.jsonl> <audit-after.jsonl> [--expected expected-additions.json] [--json]

Выгрузка «до» снята нынешним кодом выпуска, с которого переносим (web `auditDump.ts`, ядро `audit_dump.cpp`,
android `AuditDump.kt`), «после» — новым движком (`engine.call("auditDump")`, `migrate::audit`). Строка —
`{"kind","key","digest"}`; сравнение по (вид, ключ) и дайджесту:
  потеряно  — было до, нет после;
  изменено  — есть в обеих, другой дайджест;
  добавлено — нет до, есть после.
Успех (код 0) — потеряно 0, изменено 0, добавлены только виды из раздела `lines` файла ожидаемых добавлений
(`specs/035-protocol-evolution/expected-additions.json`). Новые поля значений по умолчанию (раздел `fields`) в
дайджест движка не входят (`migrate::audit::NEW_DEFAULTS`) — здесь они только печатаются для отчёта.

Отчёт — только виды, ключи и счётчики, без содержимого (`--json` — машиночитаемый).
"""
import argparse
import collections
import fnmatch
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_EXPECTED = os.path.join(HERE, "..", "specs", "035-protocol-evolution", "expected-additions.json")


def load(path):
    out = collections.defaultdict(set)
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                v = json.loads(line)
                out[(v["kind"], v["key"])].add(v["digest"])
            except (ValueError, KeyError) as e:
                raise SystemExit(f"{path}:{n}: не строка выгрузки ({e})")
    return out


def load_expected(path):
    if not path or not os.path.exists(path):
        return {"lines": [], "fields": []}
    with open(path, encoding="utf-8") as f:
        e = json.load(f)
    return {"lines": e.get("lines", []), "fields": e.get("fields", [])}


def allowed(kind, key, expected):
    for rule in expected["lines"]:
        if fnmatch.fnmatchcase(kind, rule.get("kind", "")) and fnmatch.fnmatchcase(key, rule.get("key", "*")):
            return True
    return False


def diff(before, after, expected):
    lost = sorted(k for k in before if k not in after)
    changed = sorted(k for k in before if k in after and before[k] != after[k])
    added = sorted(k for k in after if k not in before)
    unexpected = [k for k in added if not allowed(k[0], k[1], expected)]
    return lost, changed, added, unexpected


def by_kind(keys):
    c = collections.Counter(k for k, _ in keys)
    return dict(sorted(c.items()))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("before")
    p.add_argument("after")
    p.add_argument("--expected", default=DEFAULT_EXPECTED, help="ожидаемые добавления (JSON)")
    p.add_argument("--json", action="store_true", help="отчёт JSON")
    p.add_argument("--keys", action="store_true", help="печатать ключи расхождений (без содержимого)")
    a = p.parse_args()
    before, after, expected = load(a.before), load(a.after), load_expected(a.expected)
    lost, changed, added, unexpected = diff(before, after, expected)
    ok = not lost and not changed and not unexpected
    report = {
        "before": len(before), "after": len(after),
        "lost": len(lost), "changed": len(changed), "added": len(added), "unexpected_added": len(unexpected),
        "lost_by_kind": by_kind(lost), "changed_by_kind": by_kind(changed), "added_by_kind": by_kind(added),
        "ok": ok,
    }
    if a.keys:
        report["keys"] = {"lost": lost, "changed": changed, "unexpected_added": unexpected}
    if a.json:
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    else:
        print(f"строк до: {len(before)}, после: {len(after)}")
        for name, keys in (("ПОТЕРЯНО", lost), ("ИЗМЕНЕНО", changed), ("добавлено", added)):
            for kind, n in by_kind(keys).items():
                print(f"{name} {kind}: {n}")
        for kind, key in unexpected:
            print(f"НЕОЖИДАННО добавлено {kind} {key}" if a.keys else f"НЕОЖИДАННО добавлено {kind}")
        if a.keys:
            for kind, key in lost + changed:
                print(f"  {kind} {key}")
        for f in expected["fields"]:
            print(f"новое поле по умолчанию (вне дайджеста): {f.get('kind')}.{f.get('field')} = {json.dumps(f.get('default'))}")
        print(f"итог: потеряно {len(lost)}, изменено {len(changed)}, добавлено {len(added)} "
              f"(неожиданно {len(unexpected)}) — {'OK' if ok else 'РАСХОЖДЕНИЯ'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
