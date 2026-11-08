#!/usr/bin/env bash
# spec 035 T058: тест проверки манифеста выпуска. Собирает каталог артефактов из закоммиченного WASM движка
# (web-dist) и, если собран, шарда messenger; манифест → проверка проходит; затем подмены, каждая обязана
# уронить проверку: (1) WASM с лишней (допустимой) секцией — другой sha256; (2) WASM другой сборки движка
# (engineInfo сборки до spec 035 не читается) ; (3) лишний файл в web-dist.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="$ROOT/web/telegram-tt/src/lib/parvane-protocol/parvane_protocol_bg.wasm"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
RC=0
ok() { echo "PASS $*"; }
no() { echo "FAIL $*"; RC=1; }

mk() { rm -rf "$T/a"; mkdir -p "$T/a/web-dist/assets"; cp "$WASM" "$T/a/web-dist/assets/parvane_protocol_bg-abc.wasm"; echo '<html></html>' > "$T/a/web-dist/index.html"; }
mk
MESS="$ROOT/backend/target/debug/messenger"
if [ -x "$MESS" ]; then mkdir -p "$T/a/shards"; cp "$MESS" "$T/a/shards/messenger"; fi
bash "$ROOT/scripts/make_release_manifest.sh" test "$T/a" "$T/m.json" >/dev/null || { no "манифест не собран"; exit 1; }
jq -e '.artifacts[0].engineInfo.engineApi and (.schemaHash | length == 64)' "$T/m.json" >/dev/null && ok "манифест с engineInfo" || no "манифест без engineInfo"
bash "$ROOT/scripts/verify_release_manifest.sh" "$T/m.json" "$T/a" >/dev/null 2>&1 && ok "подлинный выпуск сходится" || no "подлинный выпуск не сходится"

# (1) Подмена WASM: та же сборка + пользовательская секция (модуль остаётся допустимым).
mk; [ -d "$T/a/shards" ] || true
W="$T/a/web-dist/assets/parvane_protocol_bg-abc.wasm"
printf '\x00\x05\x04evil' >> "$W"
node "$ROOT/scripts/engine_info_wasm.mjs" "$W" >/dev/null 2>&1 && ok "подменённый WASM грузится (проверка ловит по sha256)" || no "подменённый WASM не грузится"
[ -x "$MESS" ] && { mkdir -p "$T/a/shards"; cp "$MESS" "$T/a/shards/messenger"; }
bash "$ROOT/scripts/verify_release_manifest.sh" "$T/m.json" "$T/a" >/dev/null 2>&1 && no "подмена WASM не замечена" || ok "подмена WASM замечена"

# (2) WASM другой сборки движка (до spec 035: engineInfo нет).
OLD="$(git -C "$ROOT" log --format=%H -1 --before=2026-11-07 -- web/telegram-tt/src/lib/parvane-protocol/parvane_protocol_bg.wasm 2>/dev/null)"
if [ -n "$OLD" ]; then
    mk; git -C "$ROOT" show "$OLD:web/telegram-tt/src/lib/parvane-protocol/parvane_protocol_bg.wasm" > "$T/a/web-dist/assets/parvane_protocol_bg-abc.wasm"
    [ -x "$MESS" ] && { mkdir -p "$T/a/shards"; cp "$MESS" "$T/a/shards/messenger"; }
    bash "$ROOT/scripts/verify_release_manifest.sh" "$T/m.json" "$T/a" >/dev/null 2>&1 && no "чужая сборка WASM не замечена" || ok "чужая сборка WASM замечена"
fi

# (3) Лишний файл в web-dist.
mk; echo x > "$T/a/web-dist/extra.js"
[ -x "$MESS" ] && { mkdir -p "$T/a/shards"; cp "$MESS" "$T/a/shards/messenger"; }
bash "$ROOT/scripts/verify_release_manifest.sh" "$T/m.json" "$T/a" >/dev/null 2>&1 && no "лишний файл не замечен" || ok "лишний файл замечен"
exit "$RC"
