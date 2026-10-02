#!/usr/bin/env bash
# Parvane desktop — КАРТА В ПУЗЫРЕ ГЕОЛОКАЦИИ (склейка OSM-тайлов через шард
# preview, паритет с web): alice → bob точка; у обоих в пузыре собирается карта;
# после рестарта bob карта возвращается из истории; live-локация с ходами
# обновляет карту у получателя и в собственном пузыре отправителя; та же точка
# не пересобирается; conformance MAP-1 — клиент не ходит к картографическим
# хостам (тайлы только через preview.map.tile), на сервере — только шифртекст.
# Хуки PARVANE_AUTOLOCATION живут внутри ветки PARVANE_AUTOSEND — текст передаём всегда.
# Шард preview stack_start не поднимает — стартуем сами и засеваем кэш тайлов
# синтетическими PNG: прогон офлайн, OSM не нужен.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
[ -x "$SHARD/preview" ] || { echo "нет шарда $SHARD/preview — cd backend && cargo build -p preview"; exit 2; }
stack_start "${SCRATCH:-/tmp/parvane-locmap}"
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/preview.db" \
  PARVANE_LOG_LEVEL=info "$SHARD/preview" >"$SB/preview.log" 2>&1 & PREVIEW_PID=$!; PIDS+=($PREVIEW_PID)
wait_log "$SB/preview.log" "Preview шард запущен" 20 && ok "preview поднят" || bad "preview не поднялся"

# Точки сценария: статичная + live с тремя ходами (последний ход повторяет предыдущий —
# проверка «та же точка не пересобирается»)
P0="55.751244,37.618423"
L0="55.7520,37.6190"; M1="55.7530,37.6200"; M2="55.7540,37.6210"; M3="55.7540,37.6210"
# P4/P5 — далеко от остальных: на z15 близкая точка делит тайл с уже собранными, он
# берётся из LRU, и карта «собирается частично» вместо «не собрана» (1 окт 2026).
P4="55.8000,37.7000"  # точка для сценария «preview недоступен → повтор склейки»
P5="55.8500,37.7700"  # точка для сценария «устройство отсутствовало» (bob офлайн при отправке)

# Засев кэша тайлов: все тайлы z15 вокруг точек (±1 тайл) — таблица map_tiles создана
# миграцией шарда при старте; fetched_at=now попадает в TTL 7 дней.
python3 - "$SB/preview.db" "$P0" "$L0" "$M1" "$M2" "$P4" "$P5" <<'PY'
import math, sqlite3, struct, sys, time, zlib
db = sys.argv[1]; points = [tuple(map(float, p.split(','))) for p in sys.argv[2:]]
Z = 15; N = 2 ** Z  # P-23: клиент запрашивает не выше z15 (TILE_MAX_ZOOM шарда preview)
def png_rgb(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
keys = set()
for lat, lon in points:
    r = math.radians(lat)
    x = int((lon + 180) / 360 * N); y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * N)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            keys.add((Z, (x + dx) % N, y + dy))
c = sqlite3.connect(db); now = int(time.time())
for z, x, y in keys:
    c.execute("INSERT OR REPLACE INTO map_tiles(tile_key, png, fetched_at) VALUES (?, ?, ?)",
              (f"{z}/{x}/{y}", png_rgb(256, 256, (200, 220, 240)), now))
c.commit(); print(f"засеяно тайлов: {len(keys)}")
PY
[ "$(sqlite3 "$SB/preview.db" 'SELECT COUNT(*) FROM map_tiles;')" -gt 0 ] && ok "кэш тайлов засеян (офлайн)" || bad "кэш тайлов пуст"

B="$SB/bob"; A="$SB/alice"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"

# ── статичная точка ──────────────────────────────────────────────────────────
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:метка-места" PARVANE_AUTOLOCATION="bob@local:$P0")
wait_log "$A/td/log.txt" "геолокация → bob@local \(55" 40 && ok "alice отправила геолокацию" || bad "alice не отправила геолокацию"
wait_log "$B/td/log.txt" "инъецировано" 60
wait_log "$B/td/log.txt" "карта локации собрана 55.75" 60 && ok "bob: карта локации собрана (входящий пузырь)" || bad "bob: карта не собрана"
wait_log "$A/td/log.txt" "карта локации собрана 55.75" 60 && ok "alice: карта локации собрана (исходящий пузырь)" || bad "alice: карта не собрана"
grep -q "через preview" "$B/td/log.txt" && ok "MAP-1: тайлы шли через preview" || bad "MAP-1: нет маркера «через preview»"
grep -q "карта локации не собрана" "$A/td/log.txt" "$B/td/log.txt" && bad "есть «карта локации не собрана»" || ok "провалов склейки нет"
K=$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages WHERE kind='location';")
[ "${K:-0}" = "0" ] && ok "на сервере location скрыт (нет kind=location)" || bad "location на сервере открыт"
# SC-005: каждый уникальный тайл запрошен не больше одного раза за жизнь клиента
# (LRU + in-flight дедуп TileClient) — в маркерах «тайл z/x/y через preview» нет повторов
tile_dups() { grep -o "тайл [0-9/]* через preview" "$1" | sort | uniq -d | wc -l; }
[ "$(tile_dups "$B/td/log.txt")" = 0 ] && ok "SC-005 bob: повторных запросов тайлов нет" || bad "SC-005 bob: тайл запрошен повторно"
[ "$(tile_dups "$A/td/log.txt")" = 0 ] && ok "SC-005 alice: повторных запросов тайлов нет" || bad "SC-005 alice: тайл запрошен повторно"

# История после перезапуска: bob поднимается заново — карта собирается снова
stop_pid "$PB"; sleep 1
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "карта локации собрана 55.75" 60 && ok "bob после рестарта: карта из истории" || bad "bob после рестарта: карты нет"

# ── live-локация: alice перезапускается с live + 3 хода (M3 == M2) ───────────
stop_pid "$PA"; sleep 1
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:live" \
  PARVANE_AUTOLOCATION="bob@local:$L0:live=900:moves=$M1;$M2;$M3")
wait_log "$B/td/log.txt" "live-локация live_period=900" 60 && ok "bob: live-локация принята" || bad "bob: live не пришёл"
# 3 хода + стоп = 4 правки; ждём последнюю (стоп) у bob
for _ in $(seq 1 40); do
  [ "$(grep -c "правка локации применена" "$B/td/log.txt")" -ge 4 ] && break; sleep 1
done
EB=$(grep -c "правка локации применена" "$B/td/log.txt")
[ "$EB" -ge 4 ] && ok "bob: применено правок live = $EB (3 хода + стоп)" || bad "bob: правок live $EB < 4"
# Уникальных точек в live: L0, M1, M2 (M3 повторяет M2) → у bob карт ≥ 3 после live,
# у alice — исходящий пузырь обновляется теми же точками
sleep 3
MB=$(grep -c "карта локации собрана 55.75" "$B/td/log.txt")
MA=$(grep -c "карта локации собрана 55.75" "$A/td/log.txt")
[ "$MB" -ge 3 ] && ok "bob: карт live собрано $MB (≥ 3 уникальных точек)" || bad "bob: карт live $MB < 3"
[ "$MA" -ge 3 ] && ok "alice: собственный пузырь обновлён, карт $MA (≥ 3)" || bad "alice: карт $MA < 3"
# Та же точка (M3 == M2) не пересобирается: карт у bob не больше уникальных точек + запас 1
[ "$MB" -le 4 ] && ok "bob: повтор точки не пересобирал карту ($MB ≤ 4)" || bad "bob: лишние склейки ($MB)"
# После стопа счётчик стоит
sleep 5
[ "$(grep -c "карта локации собрана 55.75" "$B/td/log.txt")" -eq "$MB" ] && ok "после стопа карта не меняется" || bad "после стопа карта продолжает собираться"
# SC-005 после live: ходы L0/M1/M2 делят соседние тайлы — они взяты из кэша, не повторно
[ "$(tile_dups "$B/td/log.txt")" = 0 ] && ok "SC-005 bob после live: общие тайлы ходов из кэша" || bad "SC-005 bob после live: тайл запрошен повторно"

# ── FR-009: preview недоступен → карта не собрана → после восстановления собирается сама ──
stop_pid "$PREVIEW_PID"; sleep 1
stop_pid "$PA"; sleep 1
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:retry" PARVANE_AUTOLOCATION="bob@local:$P4")
wait_log "$B/td/log.txt" "карта локации не собрана 55.8,37.7" 60 && ok "bob: без preview карта не собрана (ожидаемо, пузырь с фоном)" || bad "bob: нет маркера «не собрана» без preview"
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/preview.db" \
  PARVANE_LOG_LEVEL=info "$SHARD/preview" >>"$SB/preview.log" 2>&1 & PREVIEW_PID=$!; PIDS+=($PREVIEW_PID)
sleep 3
# повтор по таймеру (30 с) — карта появляется без рестарта клиента
wait_log "$B/td/log.txt" "карта локации собрана 55.8,37.7" 75 && ok "bob: карта собрана повтором после восстановления preview" || bad "bob: повтор склейки не сработал"
grep -q "повтор склейки карты 55.8,37.7" "$B/td/log.txt" && ok "bob: маркер повтора склейки есть" || bad "bob: нет маркера повтора"
wait_log "$A/td/log.txt" "карта локации собрана 55.8,37.7" 30 && ok "alice: собственный пузырь тоже собран повтором" || bad "alice: повтор не сработал"

# ── устройство отсутствовало: bob офлайн, alice шлёт точку, bob поднимается → синк → карта ──
stop_pid "$PB"; sleep 1
stop_pid "$PA"; sleep 1
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="bob@local:offline" PARVANE_AUTOLOCATION="bob@local:$P5")
wait_log "$A/td/log.txt" "геолокация → bob@local \(55.85" 40 && ok "alice отправила точку, пока bob офлайн" || bad "alice не отправила точку без bob"
wait_log "$A/td/log.txt" "карта локации собрана 55.85,37.77" 60 && ok "alice: исходящий пузырь собран без получателя" || bad "alice: карта без bob не собрана"
sleep 2
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "карта локации собрана 55.85,37.77" 60 && ok "bob после офлайна: карта для сообщения из синка" || bad "bob после офлайна: карты нет"

# ── MAP-1: статическая проверка — картографических хостов в клиентском коде нет ──
HOSTS=$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["rules"][-1]["forbiddenHosts"] if False else [h for r in json.load(open(sys.argv[1]))["rules"] if r["id"]=="MAP-1" for h in r["forbiddenHosts"]]))' "$ROOT/../conformance/sync-rules.json")
HIT=0
for h in $HOSTS; do
  grep -rq --include='*.cpp' --include='*.h' -- "$h" "$ROOT/parvane-core/src" "$ROOT/parvane-core/include" \
    "$ROOT/tdesktop/Telegram/SourceFiles/parvane" && { HIT=1; echo "  найден хост $h"; }
done
[ "$HIT" = 0 ] && ok "MAP-1: картографических хостов в клиентском коде нет" || bad "MAP-1: клиент знает картографический хост"

grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "КАРТА ГЕОЛОКАЦИИ"
