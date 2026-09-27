#!/usr/bin/env bash
# Сборка форка X для эмулятора (x86_64) после правок шва: наш :app:assembleRelease
# (libparvane_jni.so для обоих ABI + JVM-тесты по флагу), оверлей setup-tgx.sh,
# затем X assembleLatestX64Debug. Печатает путь APK. arm64 и выкладка на прод —
# tgx_build_upload.sh (только по просьбе пользователя).
#   ./tgx_build_x64.sh [--tests]
set -u
export JAVA_HOME=/mnt/hdd/ub/android/jdk-17 ANDROID_HOME=/mnt/hdd/ub/android/sdk ANDROID_NDK_HOME=/mnt/hdd/ub/android/android-ndk-r27c
export PATH=$JAVA_HOME/bin:$HOME/.cargo/bin:$HOME/.local/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH
cd "$(dirname "${BASH_SOURCE[0]}")"
TASKS=":app:assembleRelease"
[ "${1:-}" = "--tests" ] && TASKS="$TASKS :libtd:testDebugUnitTest"
echo "== gradle $TASKS =="
# shellcheck disable=SC2086
/mnt/hdd/ub/android/gradle-8.9/bin/gradle $TASKS --no-daemon --console=plain > /tmp/pv-app-gradle.log 2>&1 \
  || { grep -E "error:|What went wrong|FAILED|^e: " -A3 /tmp/pv-app-gradle.log | head -40; echo "X64_BUILD rc=10"; exit 10; }
grep -E "^BUILD|tests completed" /tmp/pv-app-gradle.log | tail -2
echo "== setup-tgx.sh =="
./setup-tgx.sh > /tmp/pv-setup.log 2>&1 || { tail -20 /tmp/pv-setup.log; echo "X64_BUILD rc=2"; exit 2; }
TGX="${TGX_DIR:-/mnt/hdd/ub/android/tgx}"
echo "== X assembleLatestX64Debug =="
(cd "$TGX" && JAVA_HOME=/mnt/hdd/ub/android/jdk-21 PATH=/mnt/hdd/ub/android/jdk-21/bin:$PATH \
  ./gradlew assembleLatestX64Debug --no-daemon --console=plain -Dorg.gradle.jvmargs="-Xmx3g -XX:MaxMetaspaceSize=768m" -Dkotlin.daemon.jvmargs="-Xmx2g" > /tmp/pv-tgx-gradle.log 2>&1) \
  || { grep -E "^e: |error:|What went wrong" -A3 /tmp/pv-tgx-gradle.log | head -40; echo "X64_BUILD rc=3"; exit 3; }
ls -la --time-style=long-iso "$TGX"/app/build/outputs/apk/latestX64/debug/*.apk
echo "X64_BUILD rc=0"
