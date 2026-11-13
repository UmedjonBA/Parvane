#!/usr/bin/env bash
# PACK-1 (spec 036 T026): два одноимённых набора стикеров двух отправителей — web ↔ desktop ↔ android.
# Стенд tgx_protocol_link_flow.sh (самый свежий /tmp/pv-tgx.*): alice — desktop (первое устройство) + X (второе),
# bob — desktop. Третий отправитель — carol в web (scripts/e2e_pack_set_web.mjs).
#   1. bob (desktop) и carol (web) — у каждого свой набор «Котики» с теми же именами файлов и РАЗНЫМ содержимым;
#      bob шлёт свой стикер alice и carol, carol — alice и (в ответ, в чат со стикером bob) bob;
#   2. у получателей два разных набора: X — два локальных id при двух общих (`h:<отпечаток>`), desktop alice — две
#      ссылки, web carol — свой и чужой «Котики» установлены рядом, каждый со своими стикерами;
#   3. «В избранное» везде пишет общий id набора (ключ STICKER_PACK, вектор clients/pack-set-id.json): desktop alice
#      отмечает стикер carol — X показывает его из набора carol; X отмечает стикер bob — desktop alice видит его;
#      web carol отмечает стикер bob и свой — те же `h:<отпечаток>/<файл>`, что посчитал раннер.
#   ./tgx_pack_set_flow.sh [OUT_DIR]   (или scripts/run_protocol_mixed_e2e.sh pack-set)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
OUT="${1:-/tmp/pv-tgx-pack-set}"; rm -rf "$OUT"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"; S=$(date +%s); WEB_PORT="${PV_WEB_PORT:-4181}"
SB=$(\ls -td /tmp/pv-tgx.* 2>/dev/null | head -1)
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"
if [ -z "$SB" ] || [ ! -d "$A/td" ] || [ ! -d "$B/td" ]; then bad "нет стенда tgx_protocol_link_flow"; finish "TGX PACK-SET"; fi
esc() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }
PACK="Котики"; F1="01-1f600.png"; F2="02-1f602.png"; mkdir -p "$OUT/no-emoji"

# Наборы: те же имена файлов, разное содержимое; отпечаток PACK-2 (как web packContentHash) — для сверки ключей
read -r HB HC < <(python3 - "$OUT" "$PACK" <<'PY'
import base64, hashlib, os, struct, sys, zlib
out, pack = sys.argv[1], sys.argv[2]
def png(rgb):
    def chunk(t, d):
        b = t + d
        return struct.pack(">I", len(d)) + b + struct.pack(">I", zlib.crc32(b) & 0xffffffff)
    raw = (b"\x00" + bytes(rgb) * 96) * 96
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 96, 96, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
def write(d, colors):
    os.makedirs(d, exist_ok=True)
    files = {}
    for name, rgb in zip(["01-1f600.png", "02-1f602.png"], colors):
        files[name] = png(rgb)
        open(os.path.join(d, name), "wb").write(files[name])
    parts = b""
    for name in sorted(files, key=lambda n: n.encode()):
        data = files[name]
        parts += name.encode() + b"\x00" + struct.pack("<I", len(data)) + hashlib.sha256(data).digest()
    return base64.b64encode(hashlib.sha256(parts).digest()).decode()
hb = write(os.path.join(out, "bob-packs", pack), [(204, 36, 29), (214, 93, 14)])
hc = write(os.path.join(out, "carol"), [(69, 133, 136), (104, 157, 106)])
print(hb, hc)
PY
)
[ -n "$HB" ] && [ "$HB" != "$HC" ] && ok "наборы «$PACK»: bob h:$HB, carol h:$HC" || { bad "наборы не подготовлены"; finish "TGX PACK-SET"; }

export VITE_PARVANE_DIAG_HOOKS=1
export PARVANE_GATEWAY_ORIGIN="${PARVANE_GATEWAY_ORIGIN:-ws://127.0.0.1:* ws://localhost:*}"
if [ "${PARVANE_E2E_SKIP_WEB_BUILD:-0}" != 1 ]; then
  (cd "$REPO/web/telegram-tt" && npm run build:production >"$OUT/web-build.log" 2>&1) && ok "web собран (диаг-сборка)" || { bad "web не собрался"; finish "TGX PACK-SET"; }
fi
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X (alice2): сессия поднята" || bad "X: сессии нет"
(cd "$REPO/web/telegram-tt" && node_modules/.bin/vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$OUT/web.log" 2>&1) &
WEB_PID=$!
wait_log "$OUT/web.log" "http://127.0.0.1:$WEB_PORT" 60 && ok "web поднят" || bad "web не поднялся"
(cd "$REPO" && PARVANE_E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" PARVANE_E2E_GATEWAY_URL="ws://127.0.0.1:9222" \
  PARVANE_E2E_BACKEND_LOG_DIR="$SB" PARVANE_E2E_SHOT_DIR="$OUT" PV_OUT="$OUT" PV_STAMP="$S" PV_PACK_NAME="$PACK" \
  PV_HASH_BOB="$HB" PV_HASH_CAROL="$HC" node scripts/e2e_pack_set_web.mjs >"$OUT/web-e2e.log" 2>&1) &
NODE_PID=$!
for _ in $(seq 1 120); do [ -s "$OUT/web.carol" ] && break; sleep 1; done
CAROL=$(cat "$OUT/web.carol" 2>/dev/null)
[ -n "$CAROL" ] && ok "web: carol — $CAROL" || bad "web: carol не вошла"
for _ in $(seq 1 180); do [ -e "$OUT/web.sent" ] && break; sleep 1; done
[ -e "$OUT/web.sent" ] && ok "web: стикер набора carol отправлен alice" || bad "web: стикер carol alice не отправлен"

# bob (desktop): свой «Котики» — первый стикер alice и carol
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_STICKERS_DIR="$OUT/bob-packs" \
  PARVANE_EMOJI_DIR="$OUT/no-emoji" "PARVANE_AUTOSTICKER=alice@local,$CAROL")
wait_log "$BL" "стикер-пак «$PACK» загружен \(2 шт\), набор h:$(esc "$HB")" 60 \
  && ok "desktop bob: свой набор — общий id h:<отпечаток> (как у раннера)" || bad "desktop bob: id набора не h:$HB"
wait_log "$BL" "autosticker → $(esc "$CAROL")" 60 && ok "desktop bob: стикер отправлен alice и carol" || bad "desktop bob: стикер не отправлен"
for _ in $(seq 1 180); do [ -e "$OUT/web.sent2" ] && break; sleep 1; done
[ -e "$OUT/web.sent2" ] && ok "web: стикер набора carol отправлен bob" || bad "web: стикер carol bob не отправлен"
wait_log "$BL" "стикер из сообщения: набор h:$(esc "$HC"), файл $F2" 90 \
  && ok "desktop bob: стикер carol — набор carol (h:$HC)" || bad "desktop bob: стикер carol не опознан набором carol"

# X (alice2): оба стикера, два набора
tgx_logwait "пак=$PACK набор=h:$(esc "$HB") id=-?[0-9]+" 120 && ok "X: стикер bob — набор h:$HB" || bad "X: стикер bob не пришёл/не тот набор"
tgx_logwait "пак=$PACK набор=h:$(esc "$HC") id=-?[0-9]+" 120 && ok "X: стикер carol — набор h:$HC" || bad "X: стикер carol не пришёл/не тот набор"
XB=$(grep -aoE "набор=h:$(esc "$HB") id=-?[0-9]+" "$TGX_LOG" | tail -1 | sed 's/.* id=//')
XC=$(grep -aoE "набор=h:$(esc "$HC") id=-?[0-9]+" "$TGX_LOG" | tail -1 | sed 's/.* id=//')
[ -n "$XB" ] && [ -n "$XC" ] && [ "$XB" != "$XC" ] && ok "X: два разных набора «$PACK» ($XB ≠ $XC)" || bad "X: наборы слились ($XB / $XC)"

# desktop alice (первое устройство): стикеры обоих, «В избранное» стикер carol общим id
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOPATCH=fave|h:$HC|$F2@45")
wait_log "$AL" "стикер из сообщения: набор h:$(esc "$HB"), файл $F1" 120 && ok "desktop alice: стикер bob — набор h:$HB" || bad "desktop alice: стикер bob не опознан"
wait_log "$AL" "стикер из сообщения: набор h:$(esc "$HC"), файл $F2" 120 && ok "desktop alice: стикер carol — набор h:$HC" || bad "desktop alice: стикер carol не опознан"
wait_log "$AL" "autopatch fave h:$(esc "$HC")/$F2 → в избранном" 90 && ok "desktop alice: стикер carol в избранном" || bad "desktop alice: стикер carol не отмечен"
wait_log "$AL" "стикер $F2 в избранного — записано в журнал" 60 && ok "desktop alice: избранное в журнале" || bad "desktop alice: избранное не записано"

# X видит избранное desktop — стикер из набора carol (свой локальный id набора carol, не bob)
seen=""
for _ in $(seq 1 12); do
  tgx_mark; tgx_cmd '{"op":"faved"}' >/dev/null
  tgx_logwait "e2e-faved: .*h:$(esc "$HC")/$F2\($XC\)" 5 && { seen=1; break; }
  sleep 5
done
[ -n "$seen" ] && ok "X: избранное с desktop — стикер набора carol ($XC)" \
  || bad "X: избранное с desktop не показано из набора carol: $(grep -a 'e2e-faved:' "$TGX_LOG" | tail -1)"
# X отмечает стикер bob — desktop alice видит оба (общие id)
tgx_mark; tgx_cmd "{\"op\":\"fave\",\"set\":\"h:$HB\",\"file\":\"$F1\"}" >/dev/null
tgx_logwait "e2e-cmd fave → Ok" 30 && ok "X: стикер bob — в избранное" || bad "X: стикер bob не отмечен ($(grep -a 'e2e-cmd fave' "$TGX_LOG" | tail -1))"
stop_pid "$AP"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOPATCH=faved|-|-@40")
WANT="autopatch faved \[h:$(esc "$HB")/$F1 h:$(esc "$HC")/$F2\]|autopatch faved \[h:$(esc "$HC")/$F2 h:$(esc "$HB")/$F1\]"
wait_log "$AL" "$WANT" 100 && ok "desktop alice: в «Избранном» стикер bob (с X) и стикер carol — разные наборы" \
  || bad "desktop alice: избранное не сошлось: $(grep -a 'autopatch faved' "$AL" | tail -1)"

# web: своя часть (два набора у carol, избранное общими id)
wait "$NODE_PID"; RCW=$?
while read -r st rest; do [ "$st" = ok ] && ok "$rest" || bad "$rest"; done < <(grep -aE "^(ok|FAIL) " "$OUT/web-e2e.log")
[ "$RCW" = 0 ] && grep -aq E2E_PACK_SET_WEB_DONE "$OUT/web-e2e.log" && ok "web-часть пройдена" \
  || { bad "web-часть упала (см. $OUT/web-e2e.log)"; tail -20 "$OUT/web-e2e.log"; }

cp -p "$AL" "$OUT/alice-desktop-log.txt" 2>/dev/null; cp -p "$BL" "$OUT/bob-desktop-log.txt" 2>/dev/null
grep -qa "$PACK" "$SB"/messenger.db* 2>/dev/null && bad "имя набора лежит на сервере открыто" || ok "на сервере имени набора нет"
pkill -P "$WEB_PID" 2>/dev/null; kill "$WEB_PID" 2>/dev/null
stop_pid "$AP"; stop_pid "$BP"
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX PACK-SET"
