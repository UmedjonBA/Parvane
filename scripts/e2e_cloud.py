#!/usr/bin/env python3
"""End-to-end тест cloud-шарда: загрузка чанками → complete → download → list.

Проверяет NATS-контракт медиа-хранилища (Фаза 4), включая путь авторизации
(verify_token через identity), который не покрыт unit-тестами шарда:
  file.upload.chunk    — чанк (request/reply: ack сохранения)
  file.upload.complete — финализация файла (request/reply)
  file.download.request — отдача чанков через reply-инбокс
  file.list.request    — список файлов владельца

Требует запущенные nats + identity + cloud (их поднимает run_all_tests.sh)."""
import base64, json, subprocess, sys, time, uuid

NATS = "/home/ub/.local/bin/nats"


def req(topic, payload, timeout="3s"):
    p = subprocess.run([NATS, "req", topic, json.dumps(payload), "--timeout", timeout, "-r"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"nats req {topic} failed: {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout.strip()


def issue(user):
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


print("=== Parvane cloud-шард e2e ===")

alice = "alice@local"
jwt = issue(alice)
file_id = newid()
blob = b"parvane cloud e2e payload \x00\x01\x02"  # бинарь с нулевыми байтами
b64 = base64.b64encode(blob).decode()

# 1. upload единственного чанка (request/reply — шард подтверждает запись)
print("[1] file.upload.chunk (1 чанк, request/reply)")
chunk = {"file_id": file_id, "chunk_index": 0, "total_chunks": 1,
         "data": b64, "filename": "note.bin", "mime_type": "application/octet-stream"}
ack = json.loads(req("file.upload.chunk", envelope(alice, jwt, chunk)))
check("чанк сохранён (ack ok)", ack.get("ok") is True, str(ack))

# 2. complete
print("[2] file.upload.complete")
comp = {"file_id": file_id, "filename": "note.bin", "total_chunks": 1,
        "size_bytes": len(blob), "mime_type": "application/octet-stream"}
cr = json.loads(req("file.upload.complete", envelope(alice, jwt, comp)))
check("файл финализирован", cr.get("ok") is True, str(cr.get("error") or cr.get("file_id")))

# 3. download — первый reply на инбокс есть чанк с data
print("[3] file.download.request (single-chunk → первый reply = чанк)")
dr = json.loads(req("file.download.request", envelope(alice, jwt, {"file_id": file_id})))
check("download ok", dr.get("ok") is True, str(dr.get("error")))
got = None
if dr.get("data"):
    got = base64.b64decode(dr["data"])
check("байты совпадают с исходными", got == blob,
      f"{len(got) if got else 0}/{len(blob)} байт")

# 4. list — файл alice присутствует
print("[4] file.list.request (alice)")
lr = json.loads(req("file.list.request", envelope(alice, jwt, {})))
files = lr.get("files", [])
found = any(f.get("file_id") == file_id for f in files)
check("файл в списке alice", found, f"{len(files)} файл(ов)")
if found:
    f0 = next(f for f in files if f.get("file_id") == file_id)
    check("метаданные (имя/размер)", f0.get("filename") == "note.bin"
          and f0.get("size_bytes") == len(blob),
          f"{f0.get('filename')} {f0.get('size_bytes')}б")

# 5. чужой файл не виден bob
print("[5] изоляция владельца (bob не видит файл alice)")
jwt_b = issue("bob@local")
lb = json.loads(req("file.list.request", envelope("bob@local", jwt_b, {})))
check("bob не видит файл alice", all(f.get("file_id") != file_id for f in lb.get("files", [])),
      f"{len(lb.get('files', []))} файл(ов) у bob")

print()
if fails:
    print(f"РЕЗУЛЬТАТ: ❌ {fails} проверок провалено")
    sys.exit(1)
print("РЕЗУЛЬТАТ: ✅ все проверки прошли")
