#!/usr/bin/env python3
"""Шаги проверки отката E1 → v1 (T038, FR-056): пишет v1-сообщение с меткой
или проверяет, что все сообщения с метками видны получателю. Работает
напрямую через NATS (nats CLI, NATS_URL из окружения), как e2e_smoke.py.

  protocol_rollback_check.py write <label>
  protocol_rollback_check.py check <label> [<label> ...]
"""
import json, os, shutil, subprocess, sys, time, uuid

NATS = shutil.which("nats") or os.path.expanduser("~/.local/bin/nats")
PASSWORD = "e2e-Test-pass-2026"
ALICE, BOB = "rb_alice@local", "rb_bob@local"


def req(topic, payload, timeout="5s"):
    p = subprocess.run([NATS, "req", topic, json.dumps(payload), "--timeout", timeout, "-r"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"nats req {topic}: {p.stderr.strip() or p.stdout.strip()}")
    return json.loads(p.stdout.strip())


def pub(topic, payload):
    subprocess.run([NATS, "pub", topic, json.dumps(payload)], capture_output=True, text=True, check=True)


def issue(user):
    r = req("identity.token.issue", {"user": user, "password": PASSWORD})
    if not r.get("ok"):
        req("identity.user.register", {"user": user, "password": PASSWORD, "invite": ""})
        r = req("identity.token.issue", {"user": user, "password": PASSWORD})
    if not r.get("token"):
        raise RuntimeError(f"issue {user}: {r}")
    return r["token"]


def ev(frm, token, payload):
    return {"id": str(uuid.uuid4()), "from": frm, "ts": int(time.time()), "token": token, "payload": payload}


def text_of(m):
    c = m.get("content") or {}
    return c.get("text", "")


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("write", "check"):
        print(__doc__)
        return 2
    if sys.argv[1] == "write":
        label = sys.argv[2]
        tok = issue(ALICE)
        issue(BOB)
        e = ev(ALICE, tok, {"to": BOB, "content": {"kind": "text", "text": f"rollback:{label}"}})
        pub("msg.chat.send", e)
        time.sleep(0.5)
        print(f"  записано: {label}")
        return 0
    want = set(sys.argv[2:])
    tok = issue(BOB)
    r = req("msg.sync.request", ev(BOB, tok, {"last_seen_id": "00000000-0000-0000-0000-000000000000", "since_updated": 0}))
    msgs = (r.get("payload") or {}).get("messages", [])
    seen = {text_of(m).split(":", 1)[1] for m in msgs if text_of(m).startswith("rollback:")}
    missing = want - seen
    if missing:
        print(f"  ❌ не видны: {sorted(missing)}; видны: {sorted(seen)}")
        return 1
    print(f"  ✅ видны все: {sorted(want)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
