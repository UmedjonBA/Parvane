#!/usr/bin/env bash
# Протокол v2 (spec 007, T109): замер SC-010 — задержка доставки и трафик на
# сообщение, v2 против v1, на одном локальном стенде (nats-server + identity +
# messenger + gateway поднимает сам тест backend/tests/integration/tests/v2_bench.rs).
#
#   scripts/protocol_bench.sh            # release (по умолчанию)
#   PARVANE_BENCH_PROFILE=debug scripts/protocol_bench.sh
#   PARVANE_BENCH_N=500 PARVANE_BENCH_TEXT_LEN=256 scripts/protocol_bench.sh
#
# Итог — specs/007-protocol-v2/bench.md (таблица + условия замера) и
# сырой JSON рядом (bench.json). Нужен nats-server в PATH или ~/.local/bin.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${PARVANE_BENCH_PROFILE:-release}"
N="${PARVANE_BENCH_N:-200}"
TEXT_LEN="${PARVANE_BENCH_TEXT_LEN:-64}"
OUT_MD="${PARVANE_BENCH_OUT:-$ROOT/specs/007-protocol-v2/bench.md}"
OUT_JSON="${OUT_MD%.md}.json"
LOG="$(mktemp /tmp/parvane-bench.XXXXXX.log)"

export PATH="$HOME/.local/bin:$PATH"
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
command -v nats-server >/dev/null || { echo "nats-server не найден" >&2; exit 1; }

CARGO_FLAGS=()
[[ "$PROFILE" == "release" ]] && CARGO_FLAGS+=(--release)

echo "== v2_bench: профиль $PROFILE, N=$N, текст $TEXT_LEN байт =="
(cd "$ROOT/backend" && PARVANE_BENCH_N="$N" PARVANE_BENCH_TEXT_LEN="$TEXT_LEN" \
  cargo test "${CARGO_FLAGS[@]}" -p parvane-integration --test v2_bench -- --ignored --nocapture) 2>&1 | tee "$LOG"

JSON="$(grep -m1 '^BENCH_JSON ' "$LOG" | sed 's/^BENCH_JSON //')"
[[ -n "$JSON" ]] || { echo "нет BENCH_JSON в выводе (лог: $LOG)" >&2; exit 1; }
printf '%s\n' "$JSON" >"$OUT_JSON"

CPU="$(lscpu 2>/dev/null | sed -n 's/^Model name: *//p' | head -1)"
CORES="$(nproc)"
MEM="$(free -g | awk '/^Mem:/{print $2}')"
KERNEL="$(uname -r)"
RUSTC="$(rustc --version)"
NATS="$(nats-server --version 2>/dev/null | head -1)"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD) (+ незакоммиченные правки рабочей копии)"
DATE="$(date '+%Y-%m-%d %H:%M %Z')"

BENCH_JSON="$JSON" python3 - "$OUT_MD" <<PY
import json, os, sys
d = json.loads(os.environ["BENCH_JSON"])
v1, v2 = d["v1"], d["v2"]
def ratio(a, b):
    return (b / a - 1) * 100 if a else 0.0
def row(name, a, b, unit, fmt="{:.2f}"):
    r = ratio(a, b)
    ok = "да" if r <= 20 else "НЕТ"
    return f"| {name} | {fmt.format(a)} {unit} | {fmt.format(b)} {unit} | {r:+.1f}% | {ok} |"
rows = [
    row("Задержка p50", v1["latency_ms"]["p50"], v2["latency_ms"]["p50"], "мс"),
    row("Задержка p95", v1["latency_ms"]["p95"], v2["latency_ms"]["p95"], "мс"),
    row("Трафик отправителя / сообщение", v1["bytes_per_msg"]["sender"], v2["bytes_per_msg"]["sender"], "Б", "{:.0f}"),
    row("Трафик получателя / сообщение", v1["bytes_per_msg"]["receiver"], v2["bytes_per_msg"]["receiver"], "Б", "{:.0f}"),
    row("Трафик всего / сообщение", v1["bytes_per_msg"]["total"], v2["bytes_per_msg"]["total"], "Б", "{:.0f}"),
]
lat_ok = ratio(v1["latency_ms"]["p50"], v2["latency_ms"]["p50"]) <= 20 and ratio(v1["latency_ms"]["p95"], v2["latency_ms"]["p95"]) <= 20
bytes_ok = ratio(v1["bytes_per_msg"]["total"], v2["bytes_per_msg"]["total"]) <= 20
verdict = "ВЫПОЛНЕН" if lat_ok and bytes_ok else "НЕ выполнен"
md = f"""# Замер SC-010: v2 против v1 (T109)

> Сгенерировано \`scripts/protocol_bench.sh\` ({"$DATE"}). Повторить: \`scripts/protocol_bench.sh\`.

**SC-010**: задержка доставки и трафик на сообщение в v2 не хуже v1 более чем на 20% на том же стенде.
**Итог: {verdict}** (задержка — {"да" if lat_ok else "нет"}, трафик — {"да" if bytes_ok else "нет"}).

| Показатель | v1 (JSON) | v2 (PVN2) | v2 к v1 | ≤ +20% |
|---|---|---|---|---|
""" + "\n".join(rows) + f"""

Среднее / максимум задержки: v1 {v1["latency_ms"]["mean"]:.2f} / {v1["latency_ms"]["max"]:.2f} мс, v2 {v2["latency_ms"]["mean"]:.2f} / {v2["latency_ms"]["max"]:.2f} мс.

## Условия замера

- Сообщений: N = {d["n"]} на протокол (v1: {v1["n"]}, v2: {v2["n"]}), текст {d["text_len"]} байт, по одному (следующее — после приёма предыдущего), после разогрева (обмен в обе стороны, Olm вне pre-key).
- Сборка шардов и клиента: **{d["profile"]}**; стенд локальный, всё на одной машине, loopback.
- Стек: nats-server без ACL + identity + messenger + gateway (TCP), лимиты частоты gateway подняты (замер идёт подряд). Поднимает \`backend/tests/integration/tests/v2_bench.rs\`.
- Машина: {"$CPU"}, {"$CORES"} потоков, {"$MEM"} ГБ ОЗУ, Linux {"$KERNEL"}; {"$RUSTC"}; {"$NATS"}. Коммит {"$COMMIT"}. Во время замера на машине шла другая работа (сборки других разработчиков) — разброс p95 от этого.
- **v1** — как web/desktop v1 (\`messages.ts\`, SEND-1): кадр \`pub msg.chat.send\` по построчному JSON, событие с JWT, sealed-вариант (\`from\` пуст, \`sender_signing_key\`, подпись \`send:<id>:<ct>\`, копия устройству), содержимое — Olm-шифртекст JSON \`{{"kind":"text",…}}\`; получатель — подписка \`msg.user.<адрес>\`, live-пуш сохранённой строки. Без квитанции доставки (\`msg.chat.delivered\`) и без sync.
- **v2** — клиентское ядро \`parvane_protocol::client\`: sealed sender (HPKE поверх Olm, сертификат устройства внутри), ключ доступа собеседника (без жетонов), \`msg.deliver_sealed\` анонимным каналом (запрос + ответ), у получателя — событие \`inbox.record\` подписки \`msg.inbox.subscribe\`. Без \`msg.inbox.ack\` (web шлёт ack пачкой после sync).
- Задержка — от начала подготовки у отправителя (шифрование, подпись) до расшифрованного и проверенного сообщения у получателя (включает криптографию клиента обеих сторон, сервер и NATS).
- Трафик — байты TCP-полезной нагрузки на сокетах клиента (запись + чтение, без заголовков TCP/IP и TLS), за N сообщений / N. «Отправитель» v2 — оба его соединения (идентифицированное и анонимное).

Сырые данные — \`bench.json\` рядом.
"""
open(sys.argv[1], "w").write(md)
PY
echo "== отчёт: $OUT_MD =="
cat "$OUT_MD"
rm -f "$LOG"
