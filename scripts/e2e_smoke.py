#!/usr/bin/env python3
"""End-to-end smoke test для бэкенда Parvane (identity + messenger).
Контракт, который форк tdesktop будет реализовывать в Фазе 2-3."""
import json, subprocess, sys, time, uuid

NATS = "/home/ub/.local/bin/nats"

def req(topic, payload, timeout="3s"):
    p = subprocess.run([NATS, "req", topic, json.dumps(payload), "--timeout", timeout, "-r"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"nats req {topic} failed: {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout.strip()

def pub(topic, payload):
    p = subprocess.run([NATS, "pub", topic, json.dumps(payload)], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"nats pub {topic} failed: {p.stderr.strip()}")

def now(): return int(time.time())
def newid(): return str(uuid.uuid4())

fails = 0
def check(name, ok, detail=""):
    global fails
    print(f"  {'✅' if ok else '❌'} {name}" + (f" — {detail}" if detail else ""))
    if not ok: fails += 1

print("=== Parvane backend e2e ===")

# 1. issue JWT для alice
print("[1] identity.token.issue (alice)")
r = json.loads(req("identity.token.issue", {"user": "alice@local", "password": "test"}))
jwt = r.get("token")
check("issue ok", r.get("ok") and jwt, f"len={len(jwt) if jwt else 0}")

# 2. verify токена
print("[2] identity.token.verify")
ev = {"id": newid(), "from": "messenger", "ts": now(), "token": jwt, "payload": {"token": jwt}}
# verify контракт: messenger шлёт VerifyRequest; повторяем его форму
r = json.loads(req("identity.token.verify", {"token": jwt}))
check("verify ok", r.get("ok"), f"user={r.get('user')}")

# 3. send сообщения alice -> bob (полный ParvaneEvent<SendPayload>)
print("[3] msg.chat.send (alice -> bob)")
mid = newid()
send_ev = {
    "id": mid, "from": "alice@local", "ts": now(), "token": jwt,
    "payload": {"to": "bob@local",
                "content": {"kind": "text", "text": "привет из e2e теста"}},
}
pub("msg.chat.send", send_ev)
time.sleep(0.4)  # дать messenger записать в SQLite
check("send published", True, mid[:8])

# 4. sync для bob — ПОЛНЫЙ ParvaneEvent<SyncRequestPayload>
print("[4] msg.sync.request (bob, last_seen_id=0)")
# bob тоже логинится, чтобы получить валидный токен для своей выборки
rb = json.loads(req("identity.token.issue", {"user": "bob@local", "password": "test"}))
jwt_bob = rb["token"]
sync_ev = {
    "id": newid(), "from": "bob@local", "ts": now(), "token": jwt_bob,
    "payload": {"last_seen_id": "00000000-0000-0000-0000-000000000000",
                "since_updated": 0},
}
resp = json.loads(req("msg.sync.request", sync_ev))
msgs = resp.get("payload", {}).get("messages", [])
check("sync responded", "payload" in resp, f"{len(msgs)} msg(s)")
got = any(m.get("id") == mid for m in msgs)
check("отправленное сообщение присутствует в sync", got,
      f"ids={[m.get('id','?')[:8] for m in msgs]}")
if msgs:
    m0 = next((m for m in msgs if m.get("id") == mid), msgs[0])
    print(f"      from={m0.get('from')} to={m0.get('to')} content={m0.get('content')}")

print()
if fails:
    print(f"РЕЗУЛЬТАТ: ❌ {fails} проверок провалено")
    sys.exit(1)
print("РЕЗУЛЬТАТ: ✅ все проверки прошли")
