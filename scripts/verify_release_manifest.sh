#!/usr/bin/env bash
# spec 035 (contracts/versioning.md «Манифест выпуска», FR-048, T058): сверить артефакты выпуска с манифестом.
#
#   scripts/verify_release_manifest.sh <release-manifest.json> <каталог артефактов>
#
# Для каждого артефакта манифеста: файл/каталог на месте, sha256 (или digest образа) совпадает, engineInfo,
# извлечённый из самого артефакта (WASM — node, шард — --engine-info, desktop — --engine-info, .so — пробник),
# совпадает с записанным по schemaHash, sourceHash, engineApi, protoMinor, storageFormats; schemaHash и
# sourceHash всех артефактов — одни и те же (один выпуск). Любое расхождение — код ≠ 0.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
M="${1:?манифест}"
DIR="$(cd "${2:?каталог артефактов}" && pwd)"
command -v jq >/dev/null || { echo "нужен jq" >&2; exit 2; }
RC=0
bad() { echo "РАСХОЖДЕНИЕ: $*" >&2; RC=1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
dir_sha() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }

KEYS='{schemaHash, sourceHash, engineApi, protoMinor, storageFormats}'
same_info() { # $1 — имя, $2 — записанный engineInfo, $3 — извлечённый
    local want got
    want="$(jq -cS "$KEYS" <<<"$2")"; got="$(jq -cS "$KEYS" <<<"$3" 2>/dev/null)" || { bad "$1: engineInfo не прочитан"; return; }
    [ "$want" = "$got" ] || bad "$1: engineInfo $got вместо $want"
}

SCHEMA="$(jq -r .schemaHash "$M")"; SOURCE="$(jq -r .sourceHash "$M")"
N="$(jq '.artifacts | length' "$M")"
[ "$N" -gt 0 ] || bad "в манифесте нет артефактов"
for i in $(seq 0 $((N - 1))); do
    A="$(jq -c ".artifacts[$i]" "$M")"
    NAME="$(jq -r .name <<<"$A")"
    for k in schemaHash sourceHash; do
        v="$(jq -r ".engineInfo.$k // empty" <<<"$A")"
        want="$([ "$k" = schemaHash ] && echo "$SCHEMA" || echo "$SOURCE")"
        [ -z "$v" ] || [ "$v" = "$want" ] || bad "$NAME: $k $v — не тот выпуск ($want)"
    done
    case "$NAME" in
    web-dist)
        [ -d "$DIR/web-dist" ] || { bad "web-dist: нет каталога"; continue; }
        [ "$(dir_sha "$DIR/web-dist")" = "$(jq -r .sha256 <<<"$A")" ] || bad "web-dist: sha256 каталога"
        W="$DIR/$(jq -r .wasm_path <<<"$A")"
        [ -f "$W" ] || { bad "web-dist: нет $W"; continue; }
        [ "$(sha "$W")" = "$(jq -r .wasm_sha256 <<<"$A")" ] || bad "web-dist: sha256 WASM"
        same_info web-dist "$(jq -c .engineInfo <<<"$A")" "$(node "$ROOT/scripts/engine_info_wasm.mjs" "$W" 2>/dev/null)"
        ;;
    shards-binary)
        B="$DIR/shards/messenger"
        [ -x "$B" ] || { bad "shards: нет $B"; continue; }
        [ "$(sha "$B")" = "$(jq -r .sha256 <<<"$A")" ] || bad "shards: sha256"
        same_info shards "$(jq -c .engineInfo <<<"$A")" "$("$B" --engine-info 2>/dev/null)"
        ;;
    shards-image)
        IMG="$(jq -r .image <<<"$A")"
        D="$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMG" 2>/dev/null || docker image inspect --format '{{.Id}}' "$IMG" 2>/dev/null)"
        [ "$D" = "$(jq -r .digest <<<"$A")" ] || bad "shards-image: digest $D"
        same_info shards-image "$(jq -c .engineInfo <<<"$A")" "$(docker run --rm --entrypoint messenger "$IMG" --engine-info 2>/dev/null)"
        ;;
    desktop-release)
        B="$DIR/desktop/parvane-desktop"
        [ -x "$B" ] || { bad "desktop: нет $B"; continue; }
        [ "$(sha "$B")" = "$(jq -r .sha256 <<<"$A")" ] || bad "desktop: sha256"
        same_info desktop "$(jq -c .engineInfo <<<"$A")" "$("$B" --engine-info 2>/dev/null)"
        ;;
    android-apk)
        APK="$DIR/android/$(jq -r .file <<<"$A")"
        [ -f "$APK" ] || { bad "android: нет $APK"; continue; }
        [ "$(sha "$APK")" = "$(jq -r .sha256 <<<"$A")" ] || bad "android: sha256 APK"
        TMPD="$(mktemp -d)"
        unzip -q -o "$APK" 'lib/*' -d "$TMPD" 2>/dev/null || true
        for ABI in $(jq -r '.abis | keys[]' <<<"$A"); do
            SO="$(find "$TMPD/lib/$ABI" -name 'libparvane*.so' -type f 2>/dev/null | head -1)"
            [ -n "$SO" ] || { bad "android $ABI: нет .so"; continue; }
            [ "$(sha "$SO")" = "$(jq -r ".abis[\"$ABI\"].so_sha256" <<<"$A")" ] || bad "android $ABI: sha256 .so"
            PROBE="$DIR/android/pv_engine_info_probe-$ABI"
            if [ "$(jq ".abis[\"$ABI\"] | has(\"engineInfo\")" <<<"$A")" = true ]; then
                [ -x "$PROBE" ] || { bad "android $ABI: нет пробника"; continue; }
                same_info "android $ABI" "$(jq -c ".abis[\"$ABI\"].engineInfo" <<<"$A")" "$("$PROBE" "$SO" 2>/dev/null)"
            fi
        done
        rm -rf "$TMPD"
        ;;
    *) bad "неизвестный артефакт $NAME" ;;
    esac
done
[ "$RC" -eq 0 ] && echo "манифест сходится: $N артефактов"
exit "$RC"
