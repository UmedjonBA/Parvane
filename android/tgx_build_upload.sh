#!/usr/bin/env bash
# Полная сборка и выкладка: libparvane_jni.so → setup-tgx.sh (оверлей) → X x64+arm64 → scp arm64 на прод (web-dist/apk). Логи: /tmp/pv-app-gradle.log, /tmp/pv-setup.log, /tmp/pv-tgx-gradle.log
set -u
export JAVA_HOME=/mnt/hdd/ub/android/jdk-17 ANDROID_HOME=/mnt/hdd/ub/android/sdk ANDROID_NDK_HOME=/mnt/hdd/ub/android/android-ndk-r27c
export PATH=$JAVA_HOME/bin:$HOME/.cargo/bin:$HOME/.local/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH
cd /mnt/hdd/ub/Projects/active/Parvane/android
echo "== :app:assembleRelease (libparvane_jni.so) =="
/mnt/hdd/ub/android/gradle-8.9/bin/gradle :app:assembleRelease --no-daemon --console=plain > /tmp/pv-app-gradle.log 2>&1 || { grep -E "error:|What went wrong|FAILED" -A3 /tmp/pv-app-gradle.log | head -20; echo "TLS_DONE rc=10"; exit 10; }
TGX=/mnt/hdd/ub/android/tgx
./setup-tgx.sh > /tmp/pv-setup.log 2>&1 || { echo "оверлей упал"; echo "TLS_DONE rc=2"; exit 2; }
cd "$TGX" && JAVA_HOME=/mnt/hdd/ub/android/jdk-21 PATH=/mnt/hdd/ub/android/jdk-21/bin:$PATH ./gradlew assembleLatestArm64Debug assembleLatestX64Debug --no-daemon --console=plain > /tmp/pv-tgx-gradle.log 2>&1 || { grep -E "^e: |error:|What went wrong" -A3 /tmp/pv-tgx-gradle.log | head -20; echo "TLS_DONE rc=3"; exit 3; }
ls -la --time-style=long-iso "$TGX"/app/build/outputs/apk/latest*/debug/*.apk
scp -P 2240 -q "$TGX"/app/build/outputs/apk/latestArm64/debug/Parvane-0.28.11.1808-arm64-v8a-debug.apk umejon@185.81.248.52:parvane/web-dist/apk/parvane-tgx-arm64-debug.apk && echo "uploaded"
echo "TLS_DONE rc=0"
