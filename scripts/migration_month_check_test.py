#!/usr/bin/env python3
"""Тест scripts/migration_month_check.py (spec 035, T142 «устройство отсутствовало»): сообщение первого устройства у
второго, строки личного состояния с дайджестом первого, потери и лишние изменения второго. Данные выдуманные."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "migration_month_check.py")
D = lambda c: c * 64  # noqa: E731

BASE = [("chat", "u:bob@local", D("a")), ("message", "u:bob@local/1", D("b")), ("state:folders", "2", D("c")),
        ("state:folder_order", "_", D("d")), ("group", "g:01", D("e"))]
# Первое после правки: новая папка, новый порядок папок, сообщение
CHANGED = BASE[:3] + [("state:folder_order", "_", D("f")), ("group", "g:01", D("e")),
                      ("state:folders", "3", D("1")), ("message", "u:bob@local/2", D("2"))]


def write(path, lines):
    with open(path, "w", encoding="utf-8") as f:
        for kind, key, digest in lines:
            f.write(json.dumps({"kind": kind, "key": key, "digest": digest}) + "\n")


def run(second_after, second_before=BASE):
    with tempfile.TemporaryDirectory() as d:
        write(f"{d}/b1", BASE)
        write(f"{d}/c1", CHANGED)
        write(f"{d}/b2", second_before)
        write(f"{d}/a2", second_after)
        r = subprocess.run([sys.executable, "-I", SCRIPT, f"{d}/b1", f"{d}/c1", f"{d}/b2", f"{d}/a2", "--json"],
                           capture_output=True, text=True)
        return r.returncode, json.loads(r.stdout)


class MonthCheckTest(unittest.TestCase):
    def test_second_sees_everything(self):
        # Фото группы перезалито первым — сведения группы у второго другие, это допустимо (FR-071)
        after = [x for x in CHANGED if x[0] != "group"] + [("group", "g:01", D("9"))]
        code, r = run(after)
        self.assertEqual(code, 0, r)
        self.assertEqual((r["messages"], r["state"]), (1, 2))

    def test_message_only_in_inbox_is_missing(self):
        code, r = run([x for x in CHANGED if x[1] != "u:bob@local/2"])
        self.assertEqual(code, 1)
        self.assertEqual(r["missing_messages"], ["message u:bob@local/2"])

    def test_stale_state_written_back_fails(self):
        # Второе устройство вернуло прежний порядок папок поверх правки первого
        after = [x for x in CHANGED if x[0] != "state:folder_order"] + [("state:folder_order", "_", D("d"))]
        code, r = run(after)
        self.assertEqual(code, 1)
        self.assertEqual(r["stale_state"], ["state:folder_order _"])

    def test_lost_and_extra(self):
        after = [x for x in CHANGED if x[0] != "chat"] + [("draft", "u:bob@local", D("7"))]
        code, r = run(after)
        self.assertEqual(code, 1)
        self.assertEqual(r["lost"], ["chat u:bob@local"])
        self.assertEqual(r["extra_added"], ["draft u:bob@local"])

    def test_report_has_no_digests(self):
        _, r = run(CHANGED)
        self.assertNotIn(D("f"), json.dumps(r))


if __name__ == "__main__":
    unittest.main()
