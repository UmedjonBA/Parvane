#!/usr/bin/env python3
"""Сверка сценария «устройство отсутствовало» (spec 035 T142, conformance README; вариант month).

  migration_month_check.py <первое-после-переноса> <первое-после-правки> <второе-до> <второе-после>
                           [--messages-elsewhere] [--json]

Первое устройство аккаунта перенеслось (выгрузка «после переноса»), затем сделало правку личного состояния и
отправило сообщение (выгрузка «после правки»); сервер прогнал плановые чистки «как через месяц»
(`messenger --gc-as-of`); второе устройство того же аккаунта, выключенное всё это время, перенеслось («до» — его
выгрузка прежним кодом, «после» — новым движком). Успех (код 0):
  - у второго потеряно 0 строк из «до»;
  - сообщения, добавленные первым после переноса, у второго есть (пришли из журнала истории — инбокс вычищен);
  - строки личного состояния (`state:*`), изменённые первым, у второго с тем же дайджестом, что у первого;
  - прочее изменённое и добавленное у второго — только то, что изменил первый (и сведения групп `group`: фото
    частной группы перезаливает первое устройство, FR-071).
`--messages-elsewhere` — выгрузка клиента не несёт новых сообщений (desktop: строки `message` — из перенесённой
истории, отправленное после переноса в них не попадает); сообщение сценарий проверяет сам (журнал клиента).
Отчёт — только виды и ключи, без содержимого. Формат строк — как у `migration_audit_diff.py`.
"""
import argparse
import json
import sys


def load(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                v = json.loads(line)
                out[(v["kind"], v["key"])] = v["digest"]
            except (ValueError, KeyError) as e:
                raise SystemExit(f"{path}:{n}: не строка выгрузки ({e})")
    return out


def delta(a, b):
    changed = sorted(k for k in b if k in a and a[k] != b[k])
    added = sorted(k for k in b if k not in a)
    return changed, added


def check(base1, changed1, before2, after2, messages_elsewhere=False):
    c1, a1 = delta(base1, changed1)
    lost = sorted(k for k in before2 if k not in after2)
    c2, a2 = delta(before2, after2)
    messages = [k for k in a1 if k[0] == "message"]
    state = [k for k in c1 + a1 if k[0].startswith("state:")]
    missing = [k for k in messages if k not in after2]
    stale = [k for k in state if after2.get(k) != changed1.get(k)]
    allowed = set(c1) | set(a1)
    extra_changed = [k for k in c2 if k not in allowed and k[0] != "group"]
    extra_added = [k for k in a2 if k not in allowed]
    ok = (not lost and (messages or messages_elsewhere) and not missing and state and not stale
          and not extra_changed and not extra_added)
    fmt = lambda keys: [f"{kind} {key}" for kind, key in keys]  # noqa: E731
    return {
        "ok": bool(ok),
        "first_changed": len(c1), "first_added": len(a1),
        "messages": len(messages), "state": len(state),
        "lost": fmt(lost), "missing_messages": fmt(missing), "stale_state": fmt(stale),
        "extra_changed": fmt(extra_changed), "extra_added": fmt(extra_added),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("first_base")
    p.add_argument("first_changed")
    p.add_argument("second_before")
    p.add_argument("second_after")
    p.add_argument("--messages-elsewhere", action="store_true", help="сообщения в выгрузке не проверять")
    p.add_argument("--json", action="store_true")
    a = p.parse_args()
    r = check(load(a.first_base), load(a.first_changed), load(a.second_before), load(a.second_after),
              a.messages_elsewhere)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True))
    else:
        print(f"первое после переноса: изменено {r['first_changed']}, добавлено {r['first_added']} "
              f"(сообщений {r['messages']}, строк личного состояния {r['state']})")
        for name in ("lost", "missing_messages", "stale_state", "extra_changed", "extra_added"):
            for k in r[name]:
                print(f"{name}: {k}")
        print(f"итог: {'OK' if r['ok'] else 'РАСХОЖДЕНИЯ'}")
    return 0 if r["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
