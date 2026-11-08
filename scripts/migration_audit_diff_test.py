#!/usr/bin/env python3
"""Тест scripts/migration_audit_diff.py (spec 035, T105): потеряно / изменено / добавлено, ожидаемые добавления,
отчёт без содержимого. Данные выдуманные."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "migration_audit_diff.py")


def write(path, lines):
    with open(path, "w", encoding="utf-8") as f:
        for kind, key, digest in lines:
            f.write(json.dumps({"kind": kind, "key": key, "digest": digest}) + "\n")


def run(*args):
    r = subprocess.run([sys.executable, "-I", SCRIPT, *args], capture_output=True, text=True)
    return r.returncode, r.stdout


class AuditDiffTest(unittest.TestCase):
    def test_equal_dumps_ok(self):
        with tempfile.TemporaryDirectory() as d:
            lines = [("message", "u:bob@local/1", "a" * 64), ("chat", "u:bob@local", "b" * 64)]
            write(f"{d}/b.jsonl", lines)
            write(f"{d}/a.jsonl", list(reversed(lines)))
            rc, out = run(f"{d}/b.jsonl", f"{d}/a.jsonl", "--expected", f"{d}/none.json", "--json")
            self.assertEqual(rc, 0)
            r = json.loads(out)
            self.assertEqual((r["lost"], r["changed"], r["added"], r["ok"]), (0, 0, 0, True))

    def test_lost_changed_added(self):
        with tempfile.TemporaryDirectory() as d:
            write(f"{d}/b.jsonl", [("message", "u:bob@local/1", "a"), ("message", "u:bob@local/2", "b"), ("draft", "u:bob@local", "c")])
            write(f"{d}/a.jsonl", [("message", "u:bob@local/1", "a"), ("draft", "u:bob@local", "x"), ("note", "c0/1", "n")])
            rc, out = run(f"{d}/b.jsonl", f"{d}/a.jsonl", "--expected", f"{d}/none.json", "--json")
            self.assertEqual(rc, 1)
            r = json.loads(out)
            self.assertEqual((r["lost"], r["changed"], r["added"], r["unexpected_added"]), (1, 1, 1, 1))
            self.assertEqual(r["lost_by_kind"], {"message": 1})
            self.assertNotIn("u:bob@local", out, "без --keys ключей нет")

    def test_expected_additions(self):
        with tempfile.TemporaryDirectory() as d:
            write(f"{d}/b.jsonl", [("chat", "u:bob@local", "a")])
            write(f"{d}/a.jsonl", [("chat", "u:bob@local", "a"), ("state:faved_stickers", "p:1/s", "f")])
            with open(f"{d}/e.json", "w") as f:
                json.dump({"lines": [{"kind": "state:faved_*", "key": "*"}], "fields": []}, f)
            rc, _ = run(f"{d}/b.jsonl", f"{d}/a.jsonl", "--expected", f"{d}/e.json")
            self.assertEqual(rc, 0, "ожидаемое добавление — не расхождение")
            rc, _ = run(f"{d}/b.jsonl", f"{d}/a.jsonl", "--expected", f"{d}/none.json")
            self.assertEqual(rc, 1)

    def test_repo_expected_file_is_valid(self):
        path = os.path.join(HERE, "..", "specs", "035-protocol-evolution", "expected-additions.json")
        if not os.path.exists(path):
            self.skipTest("specs/ локальные (вне git)")
        with open(path, encoding="utf-8") as f:
            e = json.load(f)
        self.assertIsInstance(e["lines"], list)
        for fld in e["fields"]:
            self.assertTrue(fld["kind"] and fld["field"] and "default" in fld)


if __name__ == "__main__":
    unittest.main()
