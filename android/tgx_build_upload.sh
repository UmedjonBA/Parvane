#!/usr/bin/env bash
# Выпуск Android (spec 031, T077/T078): наш модуль (libparvane_jni.so) → setup-tgx.sh с release-keystore →
# X arm64 release (+ x64 release для проверки входа в эмуляторе) → apksigner verify → на прод в ~/parvane/apk/
# (Caddy отдаёт /apk/*; прежний файл — копией *.prev-<дата>.apk для отката). Только release (NAT-03): debug-APK
# debuggable и несёт dev-хуки. Ключ — /mnt/hdd/ub/android/keys/keystore-release.properties (вне git).
#   ./tgx_build_upload.sh [--no-upload]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export JAVA_HOME=/mnt/hdd/ub/android/jdk-17 ANDROID_HOME=/mnt/hdd/ub/android/sdk ANDROID_NDK_HOME=/mnt/hdd/ub/android/android-ndk-r27c
export PATH=$JAVA_HOME/bin:$HOME/.cargo/bin:$HOME/.local/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH
TGX=/mnt/hdd/ub/android/tgx
LOG=${PV_RELEASE_LOG:-/tmp/pv-release}; mkdir -p "$LOG"
export PARVANE_KEYSTORE_PROPS=/mnt/hdd/ub/android/keys/keystore-release.properties
[ -f "$PARVANE_KEYSTORE_PROPS" ] || { echo "нет $PARVANE_KEYSTORE_PROPS"; exit 2; }
cd "$HERE"
echo "== :app:assembleRelease (libparvane_jni.so) =="
/mnt/hdd/ub/android/gradle-8.9/bin/gradle :app:assembleRelease --no-daemon --console=plain -Dorg.gradle.jvmargs=-Xmx3g > "$LOG/app-gradle.log" 2>&1 \
  || { grep -E "error:|What went wrong|FAILED" -A3 "$LOG/app-gradle.log" | head -20; exit 10; }
./setup-tgx.sh > "$LOG/setup.log" 2>&1 || { tail -20 "$LOG/setup.log"; exit 2; }
echo "== X arm64 + x64 release =="
# по одной архитектуре и с двумя воркерами: два R8 разом не помещаются в память машины на 16 ГБ
: > "$LOG/tgx-gradle.log"
# x64 release (только для эмулятора) — по PV_RELEASE_X64=1: tgcalls X в RelWithDebInfo под x86_64 не линкуется
# (__tls_get_addr); эмулятор x86_64 запускает arm64-APK трансляцией ARM
TARGETS="assembleLatestArm64Release"; [ "${PV_RELEASE_X64:-0}" = 1 ] && TARGETS="$TARGETS assembleLatestX64Release"
for T in $TARGETS; do
  (cd "$TGX" && JAVA_HOME=/mnt/hdd/ub/android/jdk-21 PATH=/mnt/hdd/ub/android/jdk-21/bin:$PATH \
    ./gradlew "$T" --no-daemon --console=plain --max-workers=2 -Dorg.gradle.jvmargs=-Xmx4g >> "$LOG/tgx-gradle.log" 2>&1) \
    || { grep -E "^e: |error:|What went wrong" -A3 "$LOG/tgx-gradle.log" | head -30; exit 3; }
done
REL=$(ls "$TGX"/app/build/outputs/apk/latestArm64/release/*.apk 2>/dev/null | head -1)
REL64=$(ls "$TGX"/app/build/outputs/apk/latestX64/release/*.apk 2>/dev/null | head -1)
[ -n "$REL" ] || { echo "release-APK не найден"; exit 4; }
APKSIGNER=$(ls -d /mnt/hdd/ub/android/sdk/build-tools/*/apksigner | tail -1)
"$APKSIGNER" verify --print-certs "$REL" > "$LOG/apksigner.txt" 2>&1 && grep -q "CN=Parvane" "$LOG/apksigner.txt" \
  && echo "подпись: release-ключ Parvane" || { cat "$LOG/apksigner.txt"; exit 5; }
# Отпечаток закреплён в android/release-cert.sha256 (SHA-256 сертификата, hex) или PV_CERT_SHA256: одного CN мало —
# другой ключ с тем же CN выложил бы APK, который не обновит установленное приложение.
PIN="${PV_CERT_SHA256:-$(cat "$(dirname "$0")/release-cert.sha256" 2>/dev/null | tr -d ' :\n' | tr A-F a-f)}"
if [ -n "$PIN" ]; then
  GOT=$(grep -m1 "certificate SHA-256 digest" "$LOG/apksigner.txt" | sed 's/.*: *//' | tr -d ' :' | tr A-F a-f)
  [ "$GOT" = "$(echo "$PIN" | tr -d ' :' | tr A-F a-f)" ] || { echo "отпечаток подписи $GOT не совпал с закреплённым"; exit 5; }
else
  echo "ВНИМАНИЕ: отпечаток подписи не закреплён (android/release-cert.sha256) — проверен только CN"
fi
aapt=$(ls -d /mnt/hdd/ub/android/sdk/build-tools/*/aapt | tail -1)
"$aapt" dump badging "$REL" | grep -q "application-debuggable" && { echo "APK debuggable — не выкладываем"; exit 6; }
# Методы, которые ядро зовёт из C++ по имени, должны пережить R8 (иначе release без событий ядра и звонков)
DEXDUMP=$(ls -d /mnt/hdd/ub/android/sdk/build-tools/*/dexdump | tail -1)
DX="$LOG/dex"; rm -rf "$DX"; mkdir -p "$DX"; (cd "$DX" && unzip -q -o "$REL" 'classes*.dex')
for d in "$DX"/classes*.dex; do "$DEXDUMP" "$d" 2>/dev/null; done > "$DX/dump.txt"
for m in onEvent mediaCreate mediaCreateOffer mediaAcceptOffer mediaSetRemoteAnswer mediaAddIce mediaSetVideo mediaSetMuted mediaClose; do
  grep -q "name *: '$m'" "$DX/dump.txt" || { echo "R8 выбросил $m — release сломан (keep-правила setup-tgx.sh)"; exit 7; }
done
echo "методы для ядра в release на месте"
rm -rf "$DX"
ls -la --time-style=long-iso "$REL" ${REL64:+"$REL64"}
cp "$REL" "$LOG/parvane-android-arm64.apk"; [ -n "$REL64" ] && cp "$REL64" "$LOG/parvane-android-x64.apk"; rm -f "$TGX"/app/build/outputs/apk/latestX64/release/*.apk
[ "${1:-}" = "--no-upload" ] && { echo "RELEASE_DONE (без выкладки) $LOG"; exit 0; }
STAMP=$(date +%Y%m%d%H%M)
ssh -p 2240 umejon@185.81.248.52 "mkdir -p parvane/apk && cd parvane/apk && { [ -f parvane-android-arm64.apk ] && cp parvane-android-arm64.apk parvane-android-arm64.prev-$STAMP.apk || true; }" \
  && scp -P 2240 -q "$LOG/parvane-android-arm64.apk" umejon@185.81.248.52:parvane/apk/parvane-android-arm64.apk.new \
  && ssh -p 2240 umejon@185.81.248.52 "cd parvane/apk && mv parvane-android-arm64.apk.new parvane-android-arm64.apk && ls -la" \
  && echo "RELEASE_DONE выложено: https://parvane.duckdns.org:20443/apk/parvane-android-arm64.apk"
