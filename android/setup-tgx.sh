#!/usr/bin/env bash
# Parvane Android, стадия 3: Telegram X (GPL-3, TGX-Android/Telegram-X) поверх
# нашего шва. Клон X живёт ВНЕ репозитория (/mnt/hdd/ub/android/tgx, сабмодули
# ~1 ГБ); здесь — оверлей: подмена модуля tdlib (наш Client.kt + ParvaneStore +
# ParvaneCore + libparvane_jni.so вместо libtdjni.so), правка CMake (без tdjni),
# local.properties. Повторяемо: скрипт идемпотентен.
#   ./setup-tgx.sh            — наложить оверлей на существующий клон
#   ./setup-tgx.sh --build    — … и собрать assembleLatestArm64Debug
# Тулчейн X: JDK 21, Gradle 9.7 (wrapper), AGP 9.4, NDK r27d (27.3.13750724).
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
SDK="${ANDROID_HOME:-/mnt/hdd/ub/android/sdk}"
JDK21="${JDK21:-/mnt/hdd/ub/android/jdk-21}"
KEYS="${PARVANE_KEYS:-/mnt/hdd/ub/android/keys}"
[ -d "$TGX/app" ] || { echo "нет клона Telegram X в $TGX: git clone --recursive --depth=1 --shallow-submodules https://github.com/TGX-Android/Telegram-X $TGX"; exit 2; }
[ -x "$JDK21/bin/java" ] || { echo "нет JDK 21 в $JDK21"; exit 2; }

echo "== бандл tdlib: бинарники OpenSSL лежат в Git LFS (без git-lfs — файлы-указатели) =="
export PATH="/mnt/hdd/ub/android/tools/bin:$PATH"
if head -c 40 "$TGX/tdlib/openssl/27.3.13750724/arm64-v8a/lib/libcryptox.so" 2>/dev/null | grep -q "git-lfs"; then
  command -v git-lfs >/dev/null || { echo "нужен git-lfs (tools/bin) — см. BUILD-android.md"; exit 2; }
  (cd "$TGX/tdlib" && git lfs install --local >/dev/null 2>&1 && git lfs pull)
fi

echo "== оверлей tdlib: наш шов вместо TDLib =="
TDLIB="$TGX/tdlib/src/main/java/org/drinkless/tdlib"
mkdir -p "$TDLIB" "$TGX/tdlib/src/main/java/org/parvane/core"
rm -f "$TDLIB/Client.java"
cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/Client.kt" "$TDLIB/"
cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/ParvaneStore.kt" "$TDLIB/"
cp "$ROOT/libtd/src/main/java/org/parvane/core/ParvaneCore.kt" "$TGX/tdlib/src/main/java/org/parvane/core/"
# TdApi: у бандла X тот же коммит TDLib (tdlib/version.txt); если версии разойдутся —
# перегенерировать наш (android/BUILD-android.md) и подложить сюда
if [ -f "$TGX/tdlib/version.txt" ]; then
  echo "   TDLib бандла X: $(cat "$TGX/tdlib/version.txt")"
fi
[ -f "$TDLIB/TdApi.java" ] || cp "$ROOT/libtd/src/main/java/org/drinkless/tdlib/TdApi.java" "$TDLIB/"

echo "== нативная либа шва в jniLibs =="
for abi in arm64-v8a x86_64; do
  so="$(find "$ROOT/libtd/build/intermediates" -path "*/$abi/libparvane_jni.so" 2>/dev/null | grep -v Debug | head -1)"
  if [ -n "$so" ]; then
    mkdir -p "$TGX/tdlib/src/main/jniLibs/$abi"
    cp "$so" "$TGX/tdlib/src/main/jniLibs/$abi/"
    echo "   $abi: $(stat -c %s "$so") байт"
  else
    echo "   $abi: libparvane_jni.so не собрана (gradle :app:assembleRelease в android/) — пропуск"
  fi
done

echo "== CMake: без libtdjni (наш шов — не JNI TDLib) =="
CM="$TGX/app/jni/CMakeLists.txt"
if grep -q "^  tdjni$" "$CM"; then
  sed -i '/^  tdjni$/d' "$CM"
fi
grep -q "parvane: tdjni убран" "$CM" || sed -i '1i # parvane: tdjni убран из линковки tgxjni (шов над parvane-core, см. android/setup-tgx.sh)' "$CM"

echo "== google-services.json: клиент для нашего app.id (Firebase у нас не используется) =="
python3 - "$TGX/app/google-services.json" <<'PY'
import json, sys, copy
p = sys.argv[1]; j = json.load(open(p))
pk = "org.parvane.tgx"
if not any(c["client_info"]["android_client_info"]["package_name"] == pk for c in j["client"]):
    c = copy.deepcopy(j["client"][0])
    c["client_info"]["android_client_info"]["package_name"] = pk
    j["client"].append(c)
    json.dump(j, open(p, "w"), indent=2)
    print("   добавлен клиент", pk)
else:
    print("   клиент", pk, "уже есть")
PY

echo "== local.properties / keystore =="
[ -f "$KEYS/keystore.properties" ] || { echo "нет $KEYS/keystore.properties (см. BUILD-android.md)"; exit 2; }
cat > "$TGX/local.properties" <<PROPS
sdk.dir=$SDK
org.gradle.workers.max=8
keystore.file=$KEYS/keystore.properties
app.id=org.parvane.tgx
app.name=Parvane
app.download_url=https://parvane.duckdns.org:20443/
app.sources_url=https://github.com/TGX-Android/Telegram-X
telegram.api_id=17349
telegram.api_hash=344583e45741c457fe1862106095a5eb
youtube.api_key=
tgx.extension=none
PROPS
echo "   $TGX/local.properties записан"

if [ "${1:-}" = "--build" ]; then
  echo "== сборка assembleLatestArm64Debug (долго: ffmpeg/libvpx/webrtc) =="
  cd "$TGX"
  export JAVA_HOME="$JDK21" ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
  export PATH="$JDK21/bin:/mnt/hdd/ub/android/tools/bin:$PATH"
  ./gradlew assembleLatestArm64Debug --no-daemon --console=plain
fi
echo "== готово =="
