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

    def test_strict_log_invariants(self):
        with tempfile.TemporaryDirectory() as before, tempfile.TemporaryDirectory() as after:
            for d in (before, after):
                conn = sqlite3.connect(os.path.join(d, "messenger.db-v2.db"))
                conn.execute("CREATE TABLE group_state_log (group_id BLOB, version INTEGER, entry BLOB, PRIMARY KEY (group_id, version))")
                conn.executemany("INSERT INTO group_state_log VALUES (?, ?, ?)", [(b"g", 1, b"a"), (b"g", 2, b"b")])
                conn.commit()
                conn.close()
            # Миграция добавила колонку — журнал тот же по составу
            conn = sqlite3.connect(os.path.join(after, "messenger.db-v2.db"))
            conn.execute("ALTER TABLE group_state_log ADD COLUMN signer_user TEXT")
            conn.execute("UPDATE group_state_log SET signer_user = 'x'")
            conn.execute("CREATE TABLE group_membership_windows (group_id BLOB, user TEXT, join_v INTEGER, PRIMARY KEY (group_id, user, join_v))")
            conn.commit()
            conn.close()
            b, a = audit.dump_dir(before), audit.dump_dir(after)
            self.assertEqual(audit.strict_check(b, a), [])
            # Запись журнала подменена — нарушение (дайджест ключей другой)
            conn = sqlite3.connect(os.path.join(after, "messenger.db-v2.db"))
            conn.execute("UPDATE group_state_log SET version = 3 WHERE version = 2")
            conn.commit()
            conn.close()
            self.assertEqual(len(audit.strict_check(b, audit.dump_dir(after))), 1)

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
