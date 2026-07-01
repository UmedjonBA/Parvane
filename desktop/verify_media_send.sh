#!/usr/bin/env bash
# Parvane — отправка МЕДИА из РЕАЛЬНОГО форка (Фаза 4a, исходящее медиа).
# alice-форк отправляет файл штатным путём tdesktop
#   FileLoadTask → Api::SendConfirmedFile → Parvane::MirrorOutgoingFile
# (upload в cloud чанками + msg.chat.send с медиа-MessageContent).
# Проверяем:
#   1) форк залогинился и отправил медиа (лог "медиа отправлено", есть file_id);
#   2) bob видит file-сообщение от alice в msg.sync (kind=file, верный size);
#   3) блоб, скачанный из cloud по file_id, побайтово равен исходному файлу.
#
# Требует запущенные nats + identity + messenger + cloud и собранный бинарь.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
NATS="${NATS_BIN:-$HOME/.local/bin/nats}"
WORK="$(mktemp -d /tmp/parvane-media-alice.XXXXXX)"
LOG="$WORK/td/log.txt"
SRC="$WORK/note.bin"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
"$NATS" --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти шарды"; exit 2; }

# Тестовый блоб с нулевыми байтами (проверяем бинарную целостность).
printf 'PARVANE MEDIA E2E \x00\x01\x02 payload %s' "$(date +%s)" > "$SRC"
SZ=$(stat -c%s "$SRC")
echo "workdir: $WORK; файл: $SZ байт"

# Запускаем форк: alice логинится и шлёт файл bob (autosendfile-хук).
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN='alice@local:test' \
  PARVANE_AUTOSENDFILE="bob@local:$SRC" \
  "$BIN" -workdir "$WORK/td" >"$WORK/stdout.log" 2>&1 &
PID=$!

# Ждём строку об отправке медиа (или таймаут).
for i in $(seq 1 30); do
    grep -q "Parvane: медиа отправлено" "$LOG" 2>/dev/null && break
    sleep 1
done
sleep 1
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null

echo "── ALICE log.txt (Parvane) ──"
grep -iE "Parvane: (login|autosendfile|медиа отправлено|ошибка отправки медиа)" "$LOG" 2>/dev/null || echo "(пусто)"
echo "─────────────────────────────"

grep -q "Parvane: autosendfile → bob@local" "$LOG" && ok "форк прочитал файл (autosendfile)" || bad "autosendfile не сработал"
SENT_LINE=$(grep "Parvane: медиа отправлено" "$LOG" 2>/dev/null | tail -1)
[ -n "$SENT_LINE" ] && ok "медиа отправлено в шину" || bad "нет строки об отправке медиа"
FILE_ID=$(printf '%s' "$SENT_LINE" | sed -n 's/.*(file \([0-9a-f-]\+\).*/\1/p')
[ -n "$FILE_ID" ] && ok "получен file_id: ${FILE_ID:0:8}…" || bad "file_id не извлечён"
grep -qiE "Fatal|Unexpected in " "$LOG" && bad "фатальная ошибка в логе" || ok "без фатальных ошибок"

# Сверка через шину: bob видит file-сообщение + cloud-блоб == оригинал.
if [ -n "$FILE_ID" ]; then
    NATS_BIN="$NATS" python3 - "$SRC" "$FILE_ID" "$URL" <<'PY'
import json, os, subprocess, sys, time, uuid, base64
NATS=os.environ["NATS_BIN"]; SRC, FID, URL=sys.argv[1], sys.argv[2], sys.argv[3]
orig=open(SRC,'rb').read()
def req(t,p,to="4s"):
    r=subprocess.run([NATS,"--server",URL,"req",t,json.dumps(p),"--timeout",to,"-r"],capture_output=True,text=True)
    if r.returncode: raise SystemExit(f"nats req {t}: {r.stderr or r.stdout}")
    return r.stdout.strip()
iss=lambda u: json.loads(req("identity.token.issue",{"user":u,"password":"test"}))["token"]
now=lambda:int(time.time()); nid=lambda:str(uuid.uuid4())
env=lambda f,tk,pl:{"id":nid(),"from":f,"ts":now(),"token":tk,"payload":pl}
jb, ja = iss("bob@local"), iss("alice@local")
rc=0
def ck(n,c,d=""):
    global rc; print(("  \033[32mok  \033[0m " if c else "  \033[31mFAIL\033[0m ")+n+((" — "+d) if d else "")); rc=rc or (0 if c else 1)
r=json.loads(req("msg.sync.request", env("bob@local",jb,{"last_seen_id":"00000000-0000-0000-0000-000000000000","since_updated":0})))
media=[m for m in r.get("payload",{}).get("messages",[]) if isinstance(m.get("content"),dict) and m["content"].get("kind")=="file" and m.get("from")=="alice@local" and m["content"].get("file_id")==FID]
ck("bob sync: file-сообщение от alice с этим file_id", len(media)==1, f"нашли {len(media)}")
if media:
    ck("size_bytes совпадает", media[0]["content"].get("size_bytes")==len(orig), str(media[0]["content"].get("size_bytes")))
d=json.loads(req("file.download.request", env("alice@local",ja,{"file_id":FID})))
got=base64.b64decode(d["data"]) if d.get("data") else b""
ck("cloud-блоб == оригинал", got==orig, f"{len(got)}/{len(orig)}б")
sys.exit(rc)
PY
    [ $? -eq 0 ] || RC=1
fi

rm -rf "$WORK"
[ "$RC" -eq 0 ] && printf '\033[32mОТПРАВКА МЕДИА: OK\033[0m\n' || printf '\033[31mОТПРАВКА МЕДИА: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
