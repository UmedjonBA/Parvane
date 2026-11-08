#!/usr/bin/env bash
# spec 035 (contracts/versioning.md «Манифест выпуска», FR-048, T058): записать release-manifest.json выпуска.
#
#   scripts/make_release_manifest.sh <тег> <каталог артефактов> [файл манифеста]
#
# Каталог артефактов (что есть — то и попадает в манифест):
#   web-dist/                 собранный web (в нём ровно один *.wasm движка);
#   shards/messenger          бинарь шарда (engineInfo — `messenger --engine-info`); либо SHARDS_IMAGE=<образ>
#                             (digest — `docker image inspect`, engineInfo — `docker run --rm <образ> messenger --engine-info`);
#   desktop/parvane-desktop   выпуск desktop (engineInfo — `parvane-desktop --engine-info`);
#   android/*.apk             APK: sha256 файла и каждой lib/<abi>/*.so; engineInfo по ABI — пробником
#                             android/pv_engine_info_probe-<abi> (если положен рядом).
# Манифест по умолчанию — <каталог>/release-manifest.json. Код ≠ 0 — артефакт не прочитался.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:?тег выпуска}"
DIR="$(cd "${2:?каталог артефактов}" && pwd)"
OUT="${3:-$DIR/release-manifest.json}"
command -v jq >/dev/null || { echo "нужен jq" >&2; exit 2; }

sha() { sha256sum "$1" | cut -d' ' -f1; }
# Хеш каталога: sha256 отсортированного списка «sha256  путь».
dir_sha() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }

COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
ARTS='[]'
SCHEMA=""; SOURCE=""
note_hashes() {
    local info="$1"
    [ -z "$SCHEMA" ] && SCHEMA="$(jq -r .schemaHash <<<"$info")"
    [ -z "$SOURCE" ] && SOURCE="$(jq -r .sourceHash <<<"$info")"
    return 0
}

if [ -d "$DIR/web-dist" ]; then
    mapfile -t W < <(find "$DIR/web-dist" -name '*.wasm' -type f)
    [ "${#W[@]}" -eq 1 ] || { echo "web-dist: ожидался ровно один .wasm, найдено ${#W[@]}" >&2; exit 1; }
    INFO="$(node "$ROOT/scripts/engine_info_wasm.mjs" "${W[0]}")"
    note_hashes "$INFO"
    ARTS="$(jq --arg sha "$(dir_sha "$DIR/web-dist")" --arg w "$(sha "${W[0]}")" --arg p "${W[0]#"$DIR/"}" --argjson info "$INFO" \
        '. + [{name: "web-dist", sha256: $sha, wasm_path: $p, wasm_sha256: $w, engineInfo: $info}]' <<<"$ARTS")"
fi

if [ -x "$DIR/shards/messenger" ]; then
    INFO="$("$DIR/shards/messenger" --engine-info)"
    note_hashes "$INFO"
    ARTS="$(jq --arg sha "$(sha "$DIR/shards/messenger")" --argjson info "$INFO" '. + [{name: "shards-binary", sha256: $sha, engineInfo: $info}]' <<<"$ARTS")"
elif [ -n "${SHARDS_IMAGE:-}" ]; then
    DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' "$SHARDS_IMAGE" 2>/dev/null || docker image inspect --format '{{.Id}}' "$SHARDS_IMAGE")"
    INFO="$(docker run --rm --entrypoint messenger "$SHARDS_IMAGE" --engine-info)"
    note_hashes "$INFO"
    ARTS="$(jq --arg d "$DIGEST" --arg img "$SHARDS_IMAGE" --argjson info "$INFO" '. + [{name: "shards-image", image: $img, digest: $d, engineInfo: $info}]' <<<"$ARTS")"
fi

if [ -x "$DIR/desktop/parvane-desktop" ]; then
    INFO="$("$DIR/desktop/parvane-desktop" --engine-info)"
    note_hashes "$INFO"
    ARTS="$(jq --arg sha "$(sha "$DIR/desktop/parvane-desktop")" --argjson info "$INFO" '. + [{name: "desktop-release", sha256: $sha, engineInfo: $info}]' <<<"$ARTS")"
fi

if compgen -G "$DIR/android/*.apk" >/dev/null; then
    for APK in "$DIR"/android/*.apk; do
        TMPD="$(mktemp -d)"
        unzip -q -o "$APK" 'lib/*' -d "$TMPD" 2>/dev/null || true
        ABIS='{}'
        for SO_DIR in "$TMPD"/lib/*; do
            [ -d "$SO_DIR" ] || continue
            ABI="$(basename "$SO_DIR")"
            SO="$(find "$SO_DIR" -name 'libparvane*.so' -type f | head -1)"
            [ -n "$SO" ] || continue
            ENTRY="$(jq -n --arg s "$(sha "$SO")" '{so_sha256: $s}')"
            PROBE="$DIR/android/pv_engine_info_probe-$ABI"
            if [ -x "$PROBE" ]; then
                INFO="$("$PROBE" "$SO")"
                note_hashes "$INFO"
                ENTRY="$(jq --argjson info "$INFO" '. + {engineInfo: $info}' <<<"$ENTRY")"
            fi
            ABIS="$(jq --arg a "$ABI" --argjson e "$ENTRY" '. + {($a): $e}' <<<"$ABIS")"
        done
        rm -rf "$TMPD"
        ARTS="$(jq --arg n "$(basename "$APK")" --arg sha "$(sha "$APK")" --argjson abis "$ABIS" '. + [{name: "android-apk", file: $n, sha256: $sha, abis: $abis}]' <<<"$ARTS")"
    done
fi

[ "$(jq length <<<"$ARTS")" -gt 0 ] || { echo "в $DIR нет артефактов выпуска" >&2; exit 1; }
jq -n --arg r "$TAG" --arg c "$COMMIT" --arg s "$SCHEMA" --arg h "$SOURCE" --argjson a "$ARTS" \
    '{release: $r, commit: $c, schemaHash: $s, sourceHash: $h, artifacts: $a}' > "$OUT"
echo "манифест: $OUT ($(jq '.artifacts | length' "$OUT") артефактов)"
