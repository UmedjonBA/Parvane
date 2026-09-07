# Parvane Android — состояние и сборка ядра

Цель: Android-клиент по тому же принципу, что веб/десктоп — переиспользуем
`desktop/parvane-core` (транспорт WSS, E2E, cloud, сигналинг звонков), а UI
берём от форк-дружественного клиента на TDLib (кандидат — Telegram X), подменяя
класс `org.drinkless.tdlib.Client` нашим shim'ом поверх `parvane-core` (JNI).
Разбор кандидатов и шва — в истории; шов = `Client.send(TdApi.Function)` +
`ResultHandler.onResult(TdApi.Object)`.

## Сделано (стадия 1: тулчейн + ядро под NDK) — ✅ РАБОТАЕТ

- **NDK r27c** на HDD: `/mnt/hdd/ub/android/android-ndk-r27c`
  (`export ANDROID_NDK_HOME=/mnt/hdd/ub/android/android-ndk-r27c`).
- **Rust-таргеты Android** + `cargo-ndk` установлены (aarch64/armv7/x86_64/x86).
- **OpenSSL 3.5.1 статически под arm64-v8a** собран: `./build-openssl.sh arm64-v8a`
  → `android/prebuilt/openssl/arm64-v8a/{include,lib/libssl.a,lib/libcrypto.a}`.
- **`libparvane_core.a` под arm64-v8a собран**: `./build-core.sh arm64-v8a`
  → `android/.build/core-arm64-v8a/libparvane_core.a` (~35 МБ). Все 13 исходников
  скомпилированы clang-ом NDK, Rust-E2E (vodozemac) слинкован.

Ключевой вывод: **parvane-core переносится на Android без правок логики.**
Единственное отличие от desktop-сборки — исключён `src/transport.cpp` (прямой
NATS/cnats: на Android не нужен, транспорт только WSS `GatewayWsTransport`), и
OpenSSL/e2e берутся готовыми префиксами под ABI. Файл сборки: `android/jni/CMakeLists.txt`.

### Как пересобрать (один ABI)
```
export ANDROID_NDK_HOME=/mnt/hdd/ub/android/android-ndk-r27c
cd android
./build-openssl.sh arm64-v8a     # один раз на ABI (небыстро)
./build-core.sh   arm64-v8a      # cargo-ndk e2e + cmake/ninja core
```
Другие ABI (`armeabi-v7a`, `x86_64`) — те же две команды с другим аргументом.

## Дальше (не сделано)

1. JNI-`Client`-shim: класс формы `org.drinkless.tdlib.Client`
   (`create/send/execute/close`, `ResultHandler`) поверх `parvane_core`,
   синтез объектов `TdApi` из событий Parvane. Начать на маленьком
   `TelegramExample` (Compose, ~15 функций TDLib) как доказательство стека.
2. Android SDK + JDK + Gradle (для сборки самого приложения; ядру не нужны).
3. Перенос шва на Telegram X, наращивание покрытия функций/апдейтов TDLib.

Артефакты сборки (`.build/`, `prebuilt/`) и клоны для изучения (`_study/`) —
в `.gitignore`.
