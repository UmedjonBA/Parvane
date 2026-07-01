#!/usr/bin/env python3
"""Кладёт настоящий медиа-файл на шину как сообщение от <from> к <to>:
грузит блоб в cloud (chunk/complete) и публикует msg.chat.send с нужным kind.
Нужно для АВТО-проверки рендера приёма (голос/видео/фото) без записи с мик/камеры.

Использование: craft_media.py <from> <to> <kind> <file> [duration] [w] [h]
  kind: voice|video_note|video|photo|file
"""
import base64, json, subprocess, sys, time, uuid, os

NATS = os.environ.get("NATS_BIN", os.path.expanduser("~/.local/bin/nats"))
URL = os.environ.get("PARVANE_NATS_URL", "nats://127.0.0.1:4222")


def req(topic, payload, to="5s"):
    p = subprocess.run([NATS, "--server", URL, "req", topic, json.dumps(payload),
                        "--timeout", to, "-r"], capture_output=True, text=True)
    if p.returncode:
        raise SystemExit(f"nats req {topic}: {p.stderr or p.stdout}")
    return p.stdout.strip()


def pub(topic, payload):
    subprocess.run([NATS, "--server", URL, "pub", topic, json.dumps(payload)],
                   capture_output=True, text=True)


def issue(u):
    r = json.loads(req("identity.token.issue", {"user": u, "password": "test"}))
    return r["token"]


def env(frm, tok, pl):
    return {"id": str(uuid.uuid4()), "from": frm, "ts": int(time.time()),
            "token": tok, "payload": pl}


def main():
    frm, to, kind, path = sys.argv[1:5]
    duration = int(sys.argv[5]) if len(sys.argv) > 5 else 2
    w = int(sys.argv[6]) if len(sys.argv) > 6 else 240
    h = int(sys.argv[7]) if len(sys.argv) > 7 else 240
    data = open(path, "rb").read()
    tok = issue(frm)
    fid = str(uuid.uuid4())
    fname = os.path.basename(path)
    mime = {"voice": "audio/ogg", "video_note": "video/mp4", "video": "video/mp4",
            "photo": "image/jpeg"}.get(kind, "application/octet-stream")

    # upload одним чанком (файлы небольшие)
    b64 = base64.b64encode(data).decode()
    ack = json.loads(req("file.upload.chunk", env(frm, tok, {
        "file_id": fid, "chunk_index": 0, "total_chunks": 1, "data": b64,
        "filename": fname, "mime_type": mime})))
    assert ack.get("ok"), f"chunk ack: {ack}"
    cr = json.loads(req("file.upload.complete", env(frm, tok, {
        "file_id": fid, "filename": fname, "total_chunks": 1,
        "size_bytes": len(data), "mime_type": mime})))
    assert cr.get("ok"), f"complete: {cr}"

    # content по kind
    if kind == "voice":
        content = {"kind": "voice", "file_id": fid, "duration_secs": duration,
                   "mime": mime, "size_bytes": len(data)}
    elif kind == "video_note":
        content = {"kind": "video_note", "file_id": fid, "duration_secs": duration,
                   "width": w, "height": h, "mime": mime, "size_bytes": len(data)}
    elif kind == "video":
        content = {"kind": "video", "file_id": fid, "duration_secs": duration,
                   "width": w, "height": h, "mime": mime, "size_bytes": len(data),
                   "caption": None}
    elif kind == "photo":
        content = {"kind": "photo", "file_id": fid, "width": w, "height": h,
                   "mime": mime, "size_bytes": len(data), "caption": None}
    else:
        content = {"kind": "file", "file_id": fid, "filename": fname,
                   "mime": mime, "size_bytes": len(data), "caption": None}

    pub("msg.chat.send", env(frm, tok, {"to": to, "content": content}))
    print(f"отправлено {kind} {fname} ({len(data)}б) file_id={fid[:8]} {frm}->{to}")


if __name__ == "__main__":
    main()
