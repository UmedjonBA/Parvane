#!/usr/bin/env python3
"""End-to-end тест call-шарда: релей сигнала в инбокс получателя + история.

Проверяет контракт, который форк tdesktop реализует в Фазе 4 (звонки):
  call.signal          — клиент шлёт ParvaneEvent<CallSignalPayload>
  call.user.<addr>     — call-шард релеит сигнал в инбокс получателя
  call.history.request — история звонков пользователя (request/reply)

Требует запущенные nats + identity + call (их поднимает run_all_tests.sh)."""
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


def issue(user):
    r = json.loads(req("identity.token.issue", {"user": user, "password": "test"}))
    if not r.get("ok"):
        registered = json.loads(req("identity.user.register", {
            "user": user, "password": "test", "invite": "",
        }))
        if not registered.get("ok") and "существ" not in registered.get("error", ""):
            raise RuntimeError(f"register {user} failed: {registered}")
        r = json.loads(req("identity.token.issue", {"user": user, "password": "test"}))
    if not (r.get("ok") and r.get("token")):
        raise RuntimeError(f"issue {user} failed: {r}")
    return r["token"]


def now():
    return int(time.time())


def newid():
    return str(uuid.uuid4())


def envelope(frm, token, payload):
    return {"id": newid(), "from": frm, "ts": now(), "token": token, "payload": payload}


fails = 0


def check(name, ok, detail=""):
    global fails
    print(f"  {'✅' if ok else '❌'} {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails += 1


print("=== Parvane call-шард e2e ===")

alice, bob, mallory = "alice@local", "bob@local", "mallory@evil"
jwt_a = issue(alice)
jwt_b = issue(bob)
jwt_m = issue(mallory)
call_id = newid()

# 1. Подписаться на инбокс bob (в фоне, ждём один сигнал)
print("[1] подписка на инбокс bob (call.user.%s)" % bob)
sub = subprocess.Popen([NATS, "sub", f"call.user.{bob}", "--count=1"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(0.6)  # дать подписке установиться

# 2. alice шлёт invite → call.signal
print("[2] call.signal: alice → bob (invite)")
invite = {"to": bob, "signal": {"type": "invite", "call_id": call_id,
                                 "media": "audio", "sdp": "OFFER-SDP", "sig": "SIG-A"}}
pub("call.signal", envelope(alice, jwt_a, invite))

# 3. дождаться релея в инбоксе bob
try:
    out, _ = sub.communicate(timeout=4)
except subprocess.TimeoutExpired:
    sub.kill()
    out, _ = sub.communicate()
relayed = call_id in out and "invite" in out
check("invite отрелеен в инбокс bob", relayed,
      "call_id найден" if relayed else f"вывод: {out[:200]!r}")

# 4. история для alice — звонок в статусе ringing
print("[3] call.history.request (alice) — ожидаем ringing")
time.sleep(0.3)
h = json.loads(req("call.history.request", envelope(alice, jwt_a, {})))
calls = h.get("payload", {}).get("calls", [])
rec = next((c for c in calls if c.get("call_id") == call_id), None)
check("звонок в истории alice", rec is not None, f"{len(calls)} запис(ь/и)")
if rec:
    check("статус ringing", rec.get("status") == "ringing", rec.get("status"))
    check("caller/callee верны", rec.get("caller") == alice and rec.get("callee") == bob,
          f"{rec.get('caller')}→{rec.get('callee')}")

# 5. Mallory не может вклинить answer в чужой звонок.
print("[4] Mallory пытается подменить answer — релея быть не должно")
alice_sub = subprocess.Popen([NATS, "sub", f"call.user.{alice}", "--count=1"],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(0.3)
pub("call.signal", envelope(mallory, jwt_m,
    {"to": alice, "signal": {"type": "answer", "call_id": call_id,
                               "sdp": "MALLORY-SDP", "sig": "SIG-M"}}))
try:
    mallory_out, _ = alice_sub.communicate(timeout=1)
except subprocess.TimeoutExpired:
    alice_sub.kill()
    mallory_out, _ = alice_sub.communicate()
check("answer третьей стороны не отрелеен", call_id not in mallory_out,
      f"вывод: {mallory_out[:200]!r}" if call_id in mallory_out else "тишина в inbox")

# 6. полный жизненный цикл: answer → hangup ⇒ ended
print("[5] answer + hangup ⇒ статус ended")
pub("call.signal", envelope(bob, jwt_b,
    {"to": alice, "signal": {"type": "answer", "call_id": call_id,
                               "sdp": "ANSWER-SDP", "sig": "SIG-B"}}))
time.sleep(0.3)
pub("call.signal", envelope(alice, jwt_a,
    {"to": bob, "signal": {"type": "hangup", "call_id": call_id}}))
time.sleep(0.3)
h2 = json.loads(req("call.history.request", envelope(bob, jwt_b, {})))
rec2 = next((c for c in h2.get("payload", {}).get("calls", []) if c.get("call_id") == call_id), None)
check("звонок виден и у bob", rec2 is not None)
if rec2:
    check("финальный статус ended", rec2.get("status") == "ended", rec2.get("status"))
    check("ended_at проставлен", rec2.get("ended_at") not in (None, 0), str(rec2.get("ended_at")))

print()
if fails:
    print(f"РЕЗУЛЬТАТ: ❌ {fails} проверок провалено")
    sys.exit(1)
print("РЕЗУЛЬТАТ: ✅ все проверки прошли")
