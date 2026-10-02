#!/usr/bin/env bash
# SC-003 / инварианты 11, 25, 27, 28 (spec 007, T068, T122, T123): сервер не
# знает, кто кому пишет.
#
#  1. `leak_generate` (backend/tests/integration/tests/v2_us2_live.rs,
#     #[ignore]) поднимает nats + identity + messenger + call + gateway на
#     временных БД в $OUT, регистрирует отправителей, закрывает их
#     идентифицированные сессии и ставит отметку в журналах; затем через
#     анонимный канал: 100 личных sealed (alice → bob), сигналы звонка
#     (alice → bob, call.signal_sealed) и 100 групповых сообщений с настоящим
#     Megolm (carol → группа). Стек останавливается, БД и журналы остаются,
#     рядом — manifest.json с иглами.
#  2. Этот скрипт ищет иглы отправителей:
#     - в сырых байтах всех SQLite-файлов шардов (*.db, *-v2.db, -wal, -shm —
#       включая свободные страницы) и в журналах уровня info+ ПОСЛЕ отметки;
#     - адрес группового отправителя — по таблицам (кроме таблиц состава
#       группы: состав серверу известен по построению, R8);
#     - каталог identity (identity.db*) — только на токены сессий: он по
#       определению хранит все аккаунты и их ключи;
#     - токены (JWT) отправителей — везде, включая каталог и все журналы;
#     - id Megolm-сессии отправителя (D-07) — везде;
#     - IP и порт анонимных соединений в журнале gateway после отметки.
#     Кодировки игл: сырые байты, hex, base64 (std/без паддинга/url).
#  3. `leak_generate_media` (backend/tests/integration/tests/v2_media_live.rs,
#     #[ignore]; T123, D-08) — на отдельном стеке с cloud в $OUT/media: 20
#     вложений alice → bob (загрузка в ID-канале владельца с SHA-256
#     capability, сообщение sealed через ANON, скачивание получателем по
#     capability через ANON) и сигналы звонка alice → bob. Проверки:
#     - секреты capability и токен отправителя — нигде (все БД, все журналы);
#     - ключи отправителя — ни в одной БД, кроме каталога identity;
#     - адрес отправителя — нигде, кроме каталога и таблиц владельца блоба
#       (cloud.db files/uploads: владелец известен по построению — квота);
#     - адрес получателя — ни в БД/журнале cloud, ни в БД/журнале call;
#     - нет file_grants на вложения, таблица истории звонков calls пуста;
#     - журналы info+ после отметки — без отправителя и секретов.
#  4. Итог: 0 совпадений в обеих частях, иначе код выхода 1.
#
# Запуск: scripts/protocol_sender_leak_check.sh [каталог_результата]
# (по умолчанию local-workdirs/protocol-leak-check/<время>). Нужен nats-server.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$REPO/backend"
OUT="${1:-$REPO/local-workdirs/protocol-leak-check/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

if ! command -v nats-server >/dev/null && [[ ! -x "$HOME/.local/bin/nats-server" ]]; then
  echo "nats-server не найден (PATH или ~/.local/bin)" >&2
  exit 2
fi

echo "== генерация: $OUT"
cd "$BACKEND"
PARVANE_LEAK_DIR="$OUT" cargo test -q -p parvane-integration --test v2_us2_live -- \
  --ignored --exact leak_generate --nocapture

[[ -f "$OUT/manifest.json" ]] || { echo "manifest.json не создан" >&2; exit 1; }

FAIL=0
echo "== поиск отправителей в дампе и журналах"
python3 - "$OUT" <<'PY' || FAIL=1
import base64, glob, json, os, re, sqlite3, sys

out = sys.argv[1]
m = json.load(open(os.path.join(out, "manifest.json")))

def encodings(raw: bytes):
    """Иглы для сырого значения: байты, hex (оба регистра), base64 трёх видов."""
    v = {raw, raw.hex().encode(), raw.hex().upper().encode()}
    for enc in (base64.b64encode(raw), base64.urlsafe_b64encode(raw)):
        v.add(enc)
        v.add(enc.rstrip(b"="))
    return {x for x in v if len(x) >= 8}

def text_needles(s: str):
    return {s.encode()}

def key_needles(section):
    n = set()
    for h in section["keys_hex"]:
        n |= encodings(bytes.fromhex(h))
    return n

personal_addr = text_needles(m["personal_sender"]["address"])
group_addr = text_needles(m["group_sender"]["address"])
personal_keys = key_needles(m["personal_sender"])
group_keys = key_needles(m["group_sender"])
tokens = set()
for t in m["tokens"]:
    tokens.add(t.encode())
    # подпись JWT отдельно (третья часть) — на случай усечённого вывода
    parts = t.split(".")
    if len(parts) == 3 and len(parts[2]) >= 16:
        tokens.add(parts[2].encode())
megolm = set()
for sid in m["megolm_session_ids"]:
    megolm.add(sid.encode())
    pad = "=" * (-len(sid) % 4)
    try:
        megolm |= encodings(base64.b64decode(sid + pad))
    except Exception:
        pass

hits = []

def scan(name, blob, needles, what):
    for n in needles:
        if n in blob:
            hits.append(f"{name}: {what} ({n[:24]!r}…)")

catalog = tuple(m["catalog_dbs"])
membership = set(m["membership_tables"])
db_files = sorted(
    f for f in glob.glob(os.path.join(out, "*.db*"))
    if os.path.isfile(f)
)
print(f"файлы БД: {', '.join(os.path.basename(f) for f in db_files)}")

# 1) Сырые байты файлов БД (включая WAL и свободные страницы).
for f in db_files:
    base = os.path.basename(f)
    blob = open(f, "rb").read()
    scan(base, blob, tokens, "токен сессии отправителя")
    scan(base, blob, megolm, "id Megolm-сессии (D-07)")
    if base.startswith(catalog):
        continue
    scan(base, blob, personal_addr | personal_keys, "личный отправитель")
    scan(base, blob, group_keys, "ключ группового отправителя")

# 2) Адрес группового отправителя — по таблицам, кроме состава группы.
for f in db_files:
    base = os.path.basename(f)
    if not base.endswith(".db") or base.startswith(catalog):
        continue
    con = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
    try:
        tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for t in tables:
            if t in membership or t.startswith("sqlite_") or t.startswith("_sqlx"):
                continue
            for row in con.execute(f'SELECT * FROM "{t}"'):
                for cell in row:
                    b = cell if isinstance(cell, bytes) else str(cell).encode()
                    for n in group_addr:
                        if n in b:
                            hits.append(f"{base}.{t}: групповой отправитель в строке")
    finally:
        con.close()

# 3) Журналы info+ после отметки (шарды запущены с PARVANE_LOG_LEVEL=info).
anon_ip = re.compile(rb"127\.0\.0\.1:\d+")
for name, off in m["log_offsets"].items():
    p = os.path.join(out, name)
    if not os.path.exists(p):
        continue
    whole = open(p, "rb").read()
    scan(name, whole, tokens, "токен сессии в журнале")
    tail = whole[off:]
    scan(name + " (после отметки)", tail, personal_addr | personal_keys | group_addr | group_keys | megolm, "отправитель в журнале")
    if name == "gateway.log" and (b"127.0.0.1" in tail or anon_ip.search(tail)):
        hits.append("gateway.log (после отметки): IP/порт соединения")

# 3a) Контроль поиска: иглы обязаны находиться там, где им положено быть
# (каталог identity — адрес и ключи отправителя; состав группы — адрес
# группового отправителя). Иначе проверка ничего не доказывает.
def found_any(files, needles):
    return any(n in open(f, "rb").read() for f in files for n in needles)
cat_files = [f for f in db_files if os.path.basename(f).startswith(catalog)]
msg_v2 = [f for f in db_files if os.path.basename(f).startswith("messenger.db-v2")]
for label, files, needles in [
    ("адрес личного отправителя в каталоге", cat_files, personal_addr),
    ("ключ личного отправителя в каталоге", cat_files, personal_keys),
    ("ключ группового отправителя в каталоге", cat_files, group_keys),
    ("адрес группового отправителя в составе группы", msg_v2, group_addr),
]:
    if not found_any(files, needles):
        hits.append(f"контроль поиска не сработал: {label} не найден")
    else:
        print(f"контроль: {label} — найден (поиск работает)")

# 4) D-07: повторяющиеся идентификаторы в групповых конвертах журнала получателя.
if m["group_repeated_windows"] != 0:
    hits.append(f"групповые конверты: {m['group_repeated_windows']} повторяющихся 12-байтовых окон")

# 5) D-08: серверной истории звонков v2 нет.
for f in db_files:
    if os.path.basename(f) != "call.db":
        continue
    con = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
    try:
        n = con.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
        if n:
            hits.append(f"call.db: {n} строк истории звонков (calls)")
    finally:
        con.close()

print(f"личных отправлено: {m['personal_sent']}, в журнале получателя: {m['sealed_in_recipient_journal']}")
print(f"групповых отправлено: {m['group_sent']}, в журнале получателя: {m['group_in_recipient_journal']}")
print(f"сигналов звонка: {m['call_signals']}")
ok_counts = m["personal_sent"] == 100 and m["group_sent"] == 100 and m["group_in_recipient_journal"] >= 100
if not ok_counts:
    hits.append("генерация неполная")
if hits:
    print(f"❌ совпадений: {len(hits)}")
    for h in sorted(set(hits)):
        print("  -", h)
    sys.exit(1)
print("✅ 0 совпадений: отправитель не восстанавливается по дампу БД и журналам info+")
PY

echo "== медиа и звонки (T123, D-08): генерация в $OUT/media"
PARVANE_LEAK_DIR="$OUT/media" cargo test -q -p parvane-integration --test v2_media_live -- \
  --ignored --exact leak_generate_media --nocapture
[[ -f "$OUT/media/manifest.json" ]] || { echo "media/manifest.json не создан" >&2; exit 1; }

echo "== поиск отправителя, получателя и секретов вложений"
python3 - "$OUT/media" <<'PY' || FAIL=1
import base64, glob, json, os, re, sqlite3, sys

out = sys.argv[1]
m = json.load(open(os.path.join(out, "manifest.json")))
assert m.get("kind") == "media", "не тот manifest"

def encodings(raw: bytes):
    v = {raw, raw.hex().encode(), raw.hex().upper().encode()}
    for enc in (base64.b64encode(raw), base64.urlsafe_b64encode(raw)):
        v.add(enc)
        v.add(enc.rstrip(b"="))
    return {x for x in v if len(x) >= 8}

def hex_needles(lst):
    n = set()
    for h in lst:
        n |= encodings(bytes.fromhex(h))
    return n

sender_addr = {m["sender"]["address"].encode()}
sender_keys = hex_needles(m["sender"]["keys_hex"])
recipient = {m["recipient"]["address"].encode()}
caps = hex_needles(m["capabilities_hex"])
cap_hashes = hex_needles(m["capability_hashes_hex"])
tokens = set()
for t in m["tokens"]:
    tokens.add(t.encode())
    parts = t.split(".")
    if len(parts) == 3 and len(parts[2]) >= 16:
        tokens.add(parts[2].encode())
catalog = tuple(m["catalog_dbs"])
owner_tables = {k: set(v) for k, v in m["owner_tables"].items()}

hits = []
def scan(name, blob, needles, what):
    for n in needles:
        if n in blob:
            hits.append(f"{name}: {what} ({n[:24]!r}…)")

db_files = sorted(f for f in glob.glob(os.path.join(out, "*.db*")) if os.path.isfile(f))
print(f"файлы БД: {', '.join(os.path.basename(f) for f in db_files)}")

def owner_db(base):
    # Основная БД шарда с таблицами владельца (cloud.db, её -wal/-shm), не -v2.
    return any(base.startswith(k) and "-v2" not in base for k in owner_tables)

# 1) Сырые байты всех БД (WAL и свободные страницы включительно).
for f in db_files:
    base = os.path.basename(f)
    blob = open(f, "rb").read()
    scan(base, blob, tokens, "токен сессии отправителя")
    scan(base, blob, caps, "секрет capability вложения")
    if base.startswith(catalog):
        continue
    scan(base, blob, sender_keys, "ключ отправителя")
    if base.startswith(("cloud.db", "call.db")):
        scan(base, blob, recipient, "получатель (связь «кто кому»)")
    if not owner_db(base):
        scan(base, blob, sender_addr, "адрес отправителя")

# 2) Таблицы БД владельца: адрес отправителя — только в таблицах владельца;
#    грантов на вложения нет. История звонков пуста.
file_ids = m["file_ids"]
for f in db_files:
    base = os.path.basename(f)
    if not base.endswith(".db"):
        continue
    con = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
    try:
        tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        if base in owner_tables:
            for t in tables:
                if t in owner_tables[base] or t.startswith("sqlite_") or t.startswith("_sqlx"):
                    continue
                for row in con.execute(f'SELECT * FROM "{t}"'):
                    for cell in row:
                        b = cell if isinstance(cell, bytes) else str(cell).encode()
                        if any(n in b for n in sender_addr):
                            hits.append(f"{base}.{t}: адрес отправителя вне таблиц владельца")
            if "file_grants" in tables and file_ids:
                q = ",".join("?" * len(file_ids))
                n = con.execute(f"SELECT COUNT(*) FROM file_grants WHERE file_id IN ({q})", file_ids).fetchone()[0]
                if n:
                    hits.append(f"{base}.file_grants: {n} грантов на вложения сообщений")
        if base == "call.db" and "calls" in tables:
            n = con.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
            if n:
                hits.append(f"call.db: {n} строк истории звонков (calls)")
    finally:
        con.close()

# 3) Журналы: токены и секреты — везде; журналы cloud и call — без получателя
#    целиком; info+ после отметки — без отправителя.
anon_ip = re.compile(rb"127\.0\.0\.1:\d+")
for name, off in m["log_offsets"].items():
    p = os.path.join(out, name)
    if not os.path.exists(p):
        continue
    whole = open(p, "rb").read()
    scan(name, whole, tokens, "токен сессии в журнале")
    scan(name, whole, caps, "секрет capability в журнале")
    if name in ("cloud.log", "call.log"):
        scan(name, whole, recipient, "получатель в журнале")
    tail = whole[off:]
    scan(name + " (после отметки)", tail, sender_addr | sender_keys, "отправитель в журнале")
    if name == "gateway.log" and (b"127.0.0.1" in tail or anon_ip.search(tail)):
        hits.append("gateway.log (после отметки): IP/порт соединения")

# 4) Контроль поиска: иглы находятся там, где им положено быть.
def found_any(files, needles):
    return any(n in open(f, "rb").read() for f in files for n in needles)
by = lambda pfx: [f for f in db_files if os.path.basename(f).startswith(pfx)]
for label, files, needles in [
    ("хэши capability в cloud v2", by("cloud.db-v2"), cap_hashes),
    ("адрес отправителя-владельца в cloud.db", [f for f in by("cloud.db") if owner_db(os.path.basename(f))], sender_addr),
    ("ключ отправителя в каталоге", by(catalog), sender_keys),
    ("получатель в журнале messenger", by("messenger.db"), recipient),
]:
    if not found_any(files, needles):
        hits.append(f"контроль поиска не сработал: {label} не найден")
    else:
        print(f"контроль: {label} — найден (поиск работает)")

print(f"вложений отправлено: {m['media_sent']}, получено: {m['media_received']}, скачано по capability: {m['media_downloaded']}")
print(f"сигналов звонка: {m['call_signals']}")
if not (m["media_sent"] == 20 and m["media_received"] == 20 and m["media_downloaded"] == 20 and m["call_signals"] == 10):
    hits.append("генерация неполная")
if hits:
    print(f"❌ совпадений: {len(hits)}")
    for h in sorted(set(hits)):
        print("  -", h)
    sys.exit(1)
print("✅ 0 совпадений: вложения и звонки не создают серверной связи «кто кому»")
PY

exit "$FAIL"
