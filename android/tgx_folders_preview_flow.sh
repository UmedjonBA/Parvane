#!/usr/bin/env bash
# spec 005 / история 4 в эмуляторе: папки, превью ссылок, карта (MAP-1), поля профиля,
# глобальный поиск в форке X. После tgx_link_e2e.sh (стек в последнем /tmp/pv-tgx.*,
# X = второе устройство alice, bob — desktop). Шард preview stack_start не поднимает —
# стартуем сами с засеянным кэшем тайлов (офлайн, как verify_location_map.sh).
#   1. папка через e2e-хук (CreateChatFolder с чатом bob) → «папка 1 «Work»: 1 чатов»,
#      рестарт X → UpdateChatFolders и позиция ChatListFolder;
#   2. bob-desktop шлёт текст со ссылкой → X: MessageText.linkPreview («превью … → …» у
#      отправителя-десктопа; у X — «linkPreview=<site>» при разборе);
#      X шлёт текст со ссылкой (хук send) → «превью https://… → example.com» (через preview);
#   3. bob-desktop шлёт локацию (PARVANE_AUTOLOCATION) → X: GetMapThumbnailFile →
#      «карта … тайлов=N/N» (тайлы только из preview);
#   4. bob меняет день рождения/телефон (PARVANE_AUTOPROFILE) → X: «профиль bob@local: birthday=…»;
#      X ставит день рождения (хук) → desktop bob видит (профиль alice);
#   5. глобальный поиск (хук search) → «поиск «…»: n совпадений».
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$ROOT/../desktop/verify_lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/tgx_ui.sh" # ROOT после verify_lib.sh указывает на desktop/ (verify_paths.sh)
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -qE \"$1\"; do sleep 3; done"; }
OUT=/tmp/pv-tgx-folders; mkdir -p "$OUT"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s)
A="$SB/alice"; B="$SB/bob"
PKG=org.parvane.tgx; ACT="$PKG/org.thunderdog.challegram.MainActivity"
x_restart() { ad shell am force-stop $PKG; sleep 2; ad logcat -c; ad shell am start -n "$ACT" >/dev/null 2>&1; xlog "сессия поднята" 60; }
x_cmd() { echo "$1" > "$OUT/cmd"; ad push "$OUT/cmd" /data/local/tmp/parvane-e2e-cmd >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-e2e-cmd; }
[ "$(ad shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор жив" || { bad "эмулятора нет — сначала tgx_link_e2e.sh"; finish "TGX FOLDERS"; }
[ -x "$SHARD/preview" ] || { bad "нет шарда $SHARD/preview — cd backend && cargo build -p preview"; finish "TGX FOLDERS"; }
ad logcat -c

# preview + засев тайлов вокруг точки
P0="55.7558,37.6173"
pkill -f "target/debug/[p]review" 2>/dev/null; sleep 1
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/preview.db" PARVANE_LOG_LEVEL=info "$SHARD/preview" >"$SB/preview.log" 2>&1 & PREVIEW_PID=$!
wait_log "$SB/preview.log" "Preview шард запущен" 20 && ok "preview поднят" || bad "preview не поднялся"
python3 - "$SB/preview.db" "$P0" <<'PY'
import math, sqlite3, struct, sys, time, zlib
db = sys.argv[1]; points = [tuple(map(float, p.split(','))) for p in sys.argv[2:]]
Z = 15; N = 2 ** Z
def png_rgb(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
keys = set()
for lat, lon in points:
    r = math.radians(lat)
    x = int((lon + 180) / 360 * N); y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * N)
    for dx in (-2, -1, 0, 1, 2):
        for dy in (-2, -1, 0, 1, 2):
            keys.add((Z, (x + dx) % N, y + dy))
c = sqlite3.connect(db); now = int(time.time())
for z, x, y in keys:
    c.execute("INSERT OR REPLACE INTO map_tiles(tile_key, png, fetched_at) VALUES (?, ?, ?)", (f"{z}/{x}/{y}", png_rgb(256, 256, (200, 220, 240)), now))
c.commit(); print(f"засеяно тайлов: {len(keys)}")
PY

# 1. папка
x_cmd "{\"op\":\"folder\",\"peer\":\"bob@local\",\"title\":\"Work\"}"
xlog "папка [0-9]+ «Work»: 1 чатов" 30 && ok "X: папка создана с чатом bob" || bad "X: папка не создана"
xlog "→ X UpdateChatFolders" 10 && ok "X: UpdateChatFolders ушёл в UI" || bad "X: UpdateChatFolders не отправлен"
x_restart
xlog "→ X UpdateChatFolders" 30 && ok "X: папки восстановлены после рестарта" || bad "X: папки потеряны"
sleep 3; ad exec-out screencap -p > "$OUT/01-folders.png"

# 2. превью ссылок
IN_BEFORE=$(adb logcat -d 2>/dev/null | grep -acE "сообщение [0-9a-f-]{36} → чат [0-9-]+ \(вх\)")
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
# PARVANE_AUTOTTL=…:0 — десктоп помнит таймер чата из tgx_ttl_scheduled_flow.sh (10 с): без сброса
# текст со ссылкой самоуничтожался и глобальный поиск его не находил (27 сен 2026)
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOTTL="alice@local:0" PARVANE_AUTOSEND="alice@local:смотри https://example.com/page-$STAMP")
wait_log "$B/td/log.txt" "page-$STAMP" 60 && ok "bob отправил текст со ссылкой" || bad "bob не отправил"
# P-46: текста сообщений в logcat нет — приём сверяем по числу входящих (сам текст проверяет поиск в шаге 5)
IN_NOW=0
for _ in $(seq 1 20); do IN_NOW=$(adb logcat -d 2>/dev/null | grep -acE "сообщение [0-9a-f-]{36} → чат [0-9-]+ \(вх\)"); [ "$IN_NOW" -gt "$IN_BEFORE" ] && break; sleep 3; done
[ "$IN_NOW" -gt "$IN_BEFORE" ] && ok "X: текст со ссылкой принят" || bad "X: текст не принят"
x_cmd "{\"op\":\"send\",\"peer\":\"bob@local\",\"text\":\"ответ https://example.org/x-$STAMP\"}"
xlog "превью https://example.org/x-$STAMP → " 40 && ok "X: превью запрошено у preview при отправке (FAIL-1: с деградацией)" || bad "X: превью не запрошено"
wait_log "$B/td/log.txt" "x-$STAMP" 60 && ok "bob получил текст из X" || bad "bob не получил"

# 3. карта через preview (MAP-1)
stop_pid "$BP"
# хук AUTOLOCATION живёт внутри ветки AUTOSEND (как в desktop/verify_location_map.sh) — текст обязателен
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:метка-места-$STAMP" PARVANE_AUTOLOCATION="alice@local:$P0")
wait_log "$B/td/log.txt" "геолокация → alice@local" 60 && ok "bob отправил локацию" || bad "bob не отправил локацию"
xlog "сообщение [0-9a-f-]{36} → чат [0-9-]+ \(вх\)" 60 >/dev/null
ui_reset; ad shell input tap 540 330; sleep 6; ad exec-out screencap -p > "$OUT/02-location.png"
xlog "карта 55\.7558[0-9]*,37\.617[0-9]* z15 [0-9]+x[0-9]+ тайлов=[1-9][0-9]*/[0-9]+" 60 && ok "MAP-1 (X): карта собрана из тайлов preview" || bad "MAP-1 (X): карта не собрана (см. $OUT/02-location.png)"
xlog "тайл 15/[0-9]+/[0-9]+ через preview" 10 && ok "MAP-1 (X): тайлы шли через preview" || bad "MAP-1 (X): нет маркера «через preview»"
ad exec-out screencap -p > "$OUT/03-map.png"

# 4. профиль в обе стороны
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOPROFILE="bio=bio-$STAMP;phone=+7000$STAMP;color=3:3")
wait_log "$B/td/log.txt" "autoprofile применён" 60 && ok "bob сменил bio/телефон" || bad "bob не сменил профиль"
x_cmd "{\"op\":\"resolve\",\"peer\":\"bob@local\"}"
# P-19: телефон отдаётся только владельцу — у alice он пуст; «профиль перечитан» сверяем по цвету имени
xlog "профиль bob@local: birthday=.* color=3 phone=\$" 90 && ok "X: профиль bob перечитан, чужой телефон не виден (P-19)" || bad "X: профиль bob не перечитан"
x_cmd "{\"op\":\"birthday\",\"peer\":\"bob@local\",\"day\":7,\"month\":3,\"year\":1990}"
xlog "e2e-cmd birthday → Ok" 30 && ok "X: день рождения задан (SetBirthdate → identity)" || bad "X: день рождения не задан"
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOPROFILE="bio=bio2-$STAMP:3")
wait_log "$B/td/log.txt" "профиль alice@local: .*1990-03-07|birthday=1990-03-07" 90 && ok "desktop bob: день рождения alice из X виден" || bad "desktop bob: день рождения alice не виден"

# 5. глобальный поиск
x_cmd "{\"op\":\"search\",\"query\":\"page-$STAMP\"}"
xlog "поиск «page-$STAMP»: [1-9][0-9]* совпадений" 30 && ok "X: глобальный поиск нашёл сообщение" || bad "X: поиск не нашёл"

ad logcat -d -v time > "$OUT/logcat.txt"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "X без крашей"
ui_reset
stop_pid "$BP"; kill "$PREVIEW_PID" 2>/dev/null
echo "FOLDERS_E2E_DONE rc=$RC"
finish "TGX FOLDERS"
