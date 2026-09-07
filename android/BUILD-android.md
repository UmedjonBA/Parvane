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

## Стадия 2: шов TDLib поверх ядра + минимальное приложение — ✅ APK СОБИРАЕТСЯ

Решение: вместо форка устаревшего `TelegramExample` (AGP 7.0-alpha, Compose beta
2021 — не собирается современным тулчейном) шов доказан на СВОЁМ минимальном
Compose-приложении с тем же контрактом, что у Telegram X: UI говорит только с
`org.drinkless.tdlib.Client.send(TdApi.Function)` и апдейтами `TdApi.*`.

- `libtd/` — Android-библиотека:
  - `org/drinkless/tdlib/TdApi.java` — из бандла Telegram X (TGX-Android/tdlib,
    TDLib d1085f9, с androidx-аннотациями @IntDef/@Nullable — X на них
    опирается); свой генератор (`td_generate_java_api`) — запасной путь.
  - `org/drinkless/tdlib/Client.kt` — **shim**: `create/send/execute/close`,
    отображение авторизации TDLib на вход Parvane (WaitPhoneNumber = ник →
    WaitPassword → `identity.token.issue` → Ready; сохранённая сессия → Ready
    сразу), функции: SetTdlibParameters, GetMe, GetChat(s)/LoadChats,
    GetChatHistory, SendMessage(текст), ViewMessages, SearchPublicChat/
    SearchChatsOnServer (identity.user.search), LogOut/Close. Апдейты:
    UpdateAuthorizationState, UpdateUser, UpdateNewChat, UpdateChatTitle,
    UpdateNewMessage, UpdateChatLastMessage, UpdateChatReadInbox/Outbox.
  - `org/drinkless/tdlib/ParvaneStore.kt` — синтез объектов TdApi (адрес↔id
    FNV-1a как на десктопе, Chat/User/Message, история, непрочитанное).
  - `org/parvane/core/ParvaneCore.kt` — обёртка JNI + раздача событий ядра.
  - нативная часть: `jni/parvane_jni.cpp` → `libparvane_jni.so` (CMake-таргет
    `parvane_jni` в `jni/CMakeLists.txt`, линкует `parvane_core`): логин с
    device_id, сессия (WSS `GatewayWsTransport`, `e2e::initDevice`, инбокс,
    pump sync с подписью устройства), sealed-отправка с fan-out по устройствам,
    расшифровка + `verifySender` на приёме, ack, resolve/search, markRead.
    События в Kotlin — JSON через `ParvaneCore.onEvent`.
- `app/` — Compose-клиент: экран входа (ник → пароль), список чатов, чат с
  отправкой текста, «новый чат» по нику, выход. Gateway по умолчанию —
  тестовый прод `wss://parvane.duckdns.org:20443/ws` (`Client.gatewayUrl`).

### Тулчейн приложения (на HDD, без root)
- JDK 17 Temurin: `/mnt/hdd/ub/android/jdk-17`
- SDK: `/mnt/hdd/ub/android/sdk` (platforms;android-34, build-tools;34.0.0,
  platform-tools, cmake;3.22.1; emulator + system-images;android-34;google_apis;x86_64);
  NDK r27c подключён симлинком `sdk/ndk/27.2.12479018` (AGP ищет strip там —
  с `ndkPath` вне SDK .so уходил в APK нестрипнутым, 27 МБ вместо 11)
- Gradle 8.9: `/mnt/hdd/ub/android/gradle-8.9/bin/gradle`
- TDLib для генерации TdApi: `/mnt/hdd/ub/android/td` (build/td/generate/td_generate_java_api)

```
export JAVA_HOME=/mnt/hdd/ub/android/jdk-17 ANDROID_HOME=/mnt/hdd/ub/android/sdk \
       ANDROID_NDK_HOME=/mnt/hdd/ub/android/android-ndk-r27c \
       PATH=$JAVA_HOME/bin:$HOME/.cargo/bin:$PATH
cd android
./build-openssl.sh arm64-v8a && ./build-core.sh arm64-v8a   # один раз (префиксы под ABI)
/mnt/hdd/ub/android/gradle-8.9/bin/gradle :app:assembleDebug --no-daemon
# → app/build/outputs/apk/debug/app-debug.apk (arm64-v8a, ~80 МБ debug)
```
`local.properties` (sdk.dir) — локальный, в gitignore. Gradle сам собирает
`libparvane_jni.so` через `externalNativeBuild` (CMake берёт OpenSSL/e2e из
`prebuilt/openssl/<ABI>` и `target/<rust-target>/release`).

### Дымовой тест в эмуляторе — ✅ ЗЕЛЁНЫЙ (7 сен 2026)
`android/smoke_emulator.sh`: локальный стек (desktop/verify_lib.sh), alice/bob
регистрируются headless-десктопом, эмулятор x86_64 (AVD `parvane`,
`ANDROID_AVD_HOME=~/.config/.android/avd` — avdmanager и emulator иначе смотрят
в разные каталоги), приложение запускается с dev-extras
(`--es gateway ws://10.0.2.2:9222/ws --es autologin alice@local:test
--es autosend bob@local:текст`), проверка по logcat (тег `parvane`) и логам
десктопа: вход → sealed-сообщение bob (десктоп получил, расшифровал) →
ответ bob → приложение получило. APK: `app-x86_64-release.apk` /
`app-arm64-v8a-release.apk` (splits по ABI, R8, ~11 МБ).

## Стадия 3: Telegram X поверх шва — СОБИРАЕТСЯ И СТАРТУЕТ (остановлено 8 сен 2026)

Форк Telegram X (GPL-3, `TGX-Android/Telegram-X`, коммит в `android/tgx.commit`)
живёт вне репозитория: `/mnt/hdd/ub/android/tgx` (клон с сабмодулями ~7.5 ГБ).
В репозитории — оверлей и скрипты:

- `setup-tgx.sh [--build]` — накладывает оверлей на клон: модуль `tdlib` → наш
  шов (Client.kt/ParvaneStore.kt/ParvaneCore.kt + `libparvane_jni.so` в
  jniLibs; TdApi.java у бандла X тот же коммит TDLib d1085f9), Git LFS для
  бинарников OpenSSL бандла, CMake без `tdjni`, `NLoader.kt` грузит
  `parvane_jni`, `google-services.json` получает клиента `org.parvane.tgx`,
  `local.properties`/keystore; `--build` = `assembleLatestArm64Debug`.
- `tgx-overlay/` — наши файлы для X: `ParvaneNickController.java` (экран
  входа по нику вместо телефонного `PhoneController`; пароль — родной
  `PasswordController`), подключается в `MainActivity`/`IntroController`.
- `tgx_iterate.sh` — оверлей → инкрементальная сборка x64 → переустановка в
  запущенный эмулятор → logcat + скриншот.
- `tgx_emulator_run.sh`, `tgx_login_flow.sh` (интро → ник → пароль → чаты,
  автоматически), `tgx_session_flow.sh` (готовая сессия через токен из NATS,
  минуя экран пароля).

Что проверено: APK `Parvane-0.28.11.1808-{arm64-v8a,x64}-debug.apk` собираются
(65 МБ; внутри `libparvane_jni.so`, без `libtdjni`), приложение стартует на
шове без крашей, показывает интро и экран ника в стиле X, шов отвечает на
стартовые запросы X (`updateOption version/commit_hash/my_id`, `SetAlarm`,
`GetProxies`, `GetApplicationConfig`, заглушки Ok для сеттеров по generic-типу
результата), ник уходит в шов и X переходит к экрану пароля.

Где остановились: **хостовый эмулятор (qemu) падает с SIGSEGV ровно при
переходе X на экран пароля** — не GPU (падает и с `swiftshader_indirect`, и с
`-gpu guest`), не звук (`-audio none`), не камера/метрики; перед падением в
госте — старт AudioFlinger и `wpa_supplicant BEACON-LOSS`. С `-feature -Wifi`
падения не было, но у гостя пропала сеть (WS handshake к 10.0.2.2 не прошёл),
поэтому обход через готовую сессию (`tgx_session_flow.sh`) до списка чатов не
доведён. На реальном телефоне этой проблемы нет (это баг эмулятора), но живой
тест форка на телефоне не делался.

Как возобновить: (1) прогнать `tgx_session_flow.sh` с сетью (без `-feature
-Wifi`; падение на экране пароля этот путь обходит) → список чатов; (2) по
`unimplemented.txt` наращивать функции TDLib в `Client.kt` (X обрабатывает 189
апдейтов, `Tdlib.java`); (3) arm64-APK форка на телефон против тестового прода.

## Дальше

1. Живой тест arm64-APK своего клиента на телефоне против тестового прода:
   вход, чат с веб-аккаунтом, приём/отправка.
2. Перенос шва на Telegram X: их `Client.java` → наш `Client.kt`, их TdApi
   (совместимость DTO), наращивание функций/апдейтов (медиа, группы, звонки —
   в ядре уже есть cloud/group/call клиенты).
3. Регистрация из приложения (сейчас — через веб), кросс-девайс прочитанное
   (ReadNotice уже приходит событием read), аватары через cloud.

Артефакты сборки (`.build/`, `prebuilt/`) и клоны для изучения (`_study/`) —
в `.gitignore`.
