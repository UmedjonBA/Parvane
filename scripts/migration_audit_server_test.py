#!/usr/bin/env python3
"""Тест scripts/migration_audit_server.py (spec 035, T007): выгрузка по таблицам, сравнение. Данные выдуманные."""
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import migration_audit_server as audit  # noqa: E402


def make_db(path, rows):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE log (seq INTEGER PRIMARY KEY, body BLOB NOT NULL)")
    conn.execute("CREATE TABLE plain (name TEXT, value INTEGER)")
    conn.executemany("INSERT INTO log VALUES (?, ?)", rows)
    conn.execute("INSERT INTO plain VALUES ('a', 1)")
    conn.commit()
    conn.close()


class AuditServerTest(unittest.TestCase):
    def test_dump_and_compare(self):
        with tempfile.TemporaryDirectory() as before, tempfile.TemporaryDirectory() as after:
            make_db(os.path.join(before, "messenger.db"), [(1, b"\x00\x01"), (2, b"\x02")])
            make_db(os.path.join(after, "messenger.db"), [(2, b"\x02"), (1, b"\x00\x01")])
            b, a = audit.dump_dir(before), audit.dump_dir(after)
            self.assertEqual([(l["kind"], l["key"], l["rows"]) for l in b],
                             [("sqlite:messenger", "log", 2), ("sqlite:messenger", "plain", 1)])
            self.assertEqual(b, a, "порядок вставки не влияет на дайджест")
            self.assertEqual(audit.compare(b, a), 0)
            conn = sqlite3.connect(os.path.join(after, "messenger.db"))
            conn.execute("DELETE FROM log WHERE seq = 1")
            conn.commit()
            conn.close()
            self.assertEqual(audit.compare(b, audit.dump_dir(after)), 1, "строк стало меньше — провал")

    def test_cli_dump_has_no_content(self):
        with tempfile.TemporaryDirectory() as d:
            make_db(os.path.join(d, "identity.db"), [(1, b"secret-bytes")])
            out = subprocess.run([sys.executable, os.path.join(HERE, "migration_audit_server.py"), "--dump", d],
                                 check=True, capture_output=True, text=True).stdout
            self.assertIn('"kind":"sqlite:identity"', out)
            self.assertNotIn("secret", out)
            self.assertNotIn(b"secret-bytes".hex(), out)


if __name__ == "__main__":
    unittest.main()
