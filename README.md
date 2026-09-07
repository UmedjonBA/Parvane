# Parvane

**Parvane** — федеративная self-hosted платформа: мессенджер, облако, заметки,
расписание (и в планах умный дом). Названа в честь Парванэ — мотылька-вестника
из персидской мифологии.

Архитектура построена вокруг шины сообщений NATS и набора независимых
Rust-сервисов («шардов»), каждый со своей встроенной базой SQLite. Постоянное
хранение — ответственность шарда, шина передаёт события и ничего не хранит.

---

## Статус реализации

| Компонент | Назначение | Состояние |
|---|---|---|
| `parvane-types` | Общие типы событий, payload'ы, CRDT-типы, константы топиков | ✅ готов |
| `identity` | Выдача и проверка JWT, учётные записи | ✅ готов |
| `messenger` | Сообщения (текст + медиа), доставка, прочтение, офлайн-синхронизация | ✅ готов |
| `cloud` | Загрузка/скачивание файлов чанками, список файлов | ✅ готов |
| `notes` | Заметки, текстовый CRDT (RGA) | ✅ готов |
| `calendar` | События, CRDT (per-field LWW) | ✅ готов |
| `call` | Сигналинг звонков (WebRTC SDP/ICE) + история | ✅ готов |
| `gateway` | Единая доверенная точка входа (TCP/WS), JWT-auth, изоляция инбоксов, лимиты частоты | ✅ готов |
| `client` (`web/`) | **Основной** клиент — форк Telegram Web A (TS) | ✅ задеплоен на прод; мессенджер + звонки + **E2E по умолчанию**, паритет-фичи, русская локализация, 2FA через Telegram |
| `client` (`desktop/`) | Клиент — форк Telegram Desktop (C++/Qt) | ✅ паритет с вебом; ходит на прод по **WSS** (`gateway`), вход по нику, 2FA |
| `client` (`android/`) | Клиент — shim TDLib `Client` над `parvane-core` (JNI): свой Compose-клиент + форк Telegram X | 🟡 свой клиент: APK собирается, дымовой тест в эмуляторе зелёный (вход, E2E-текст); форк Telegram X собирается и стартует на шове, **разработка приостановлена 8 сен 2026** (см. `android/BUILD-android.md`) |
| `smarthome` | Умный дом, RBAC по устройствам | ⛔ заморожен |

Клиентов три, все на общем контракте NATS/JSON: **веб** (основной, задеплоен),
**десктоп** (форк tdesktop) и **Android** (в работе). Принцип везде один — берём
зрелый клиент Telegram и подменяем его сетевой слой на наш (`web`: провайдер
вместо MTProto/GramJS; `desktop`: `parvane-core` вместо MTProto; `android`:
планируется shim TDLib поверх `parvane-core`). Прод-путь клиентов — через
`gateway` по **WSS** (`wss://<host>/ws`); прямой NATS остаётся для дева.

### E2E-шифрование и безопасность (сделано)

Parvane шифрует **сквозно по умолчанию везде** (в отличие от Telegram, где E2E —
только «секретные чаты»):

- **1-на-1 текст и медиа** — Olm (X3DH + Double Ratchet, Curve25519/AES-256/HMAC-SHA256)
  через [vodozemac](https://github.com/matrix-org/vodozemac) (крипто-библиотека, не Matrix-инфраструктура).
- **Группы** — Megolm (sender keys) + **ротация ключа** при удалении участника (forward secrecy).
- **Медиа-блобы** — AES-256-GCM локально; в `cloud` лежит только шифртекст, ключ едет внутри E2E-сообщения.
- **Sealed sender** — реальный отправитель спрятан внутри шифртекста, сервер видит `from=''`.
- **Safety numbers** (Signal-style) в профиле контакта — ручная проверка от MITM.
- **Самоуничтожение (TTL)** — таймер внутри E2E-контента; получатель ставит нативный `ttl_period`.
- **Локальный персист истории** — переписка (свои + принятые) переживает рестарт/релогин.
- Инфраструктура: **TLS на NATS**, пароли **argon2id**, JWT на **Ed25519**.

Паритет-фичи (нативный UI tdesktop кормится нашими данными): форматирование текста,
превью ссылок, реакции/пин/ответы/пересылка/поиск, **@упоминания**, **папки**,
**черновики**, **админка групп** (роли, add/kick, выйти), **опросы** (создание/
голоса/закрытие внутри E2E, сервер голосов не видит; агрегация на клиенте),
**стикеры** (локальные паки → нативная панель, отправка/приём через E2E) и
**GIF-приём** (attach `.gif` → автоплей). Пробелы: анимированные tgs/webm-стикеры,
кастом-эмодзи, вкладка GIFs (см. `desktop/PARITY-telegram.md`).

**Тесты:** unit-тесты бэкенда (`cargo test --workspace`, включая argon2 и
crypto vodozemac) + слой `parvane-core` клиента (transport, messenger, crypto/SAS,
call, group…) — все зелёные. Живые e2e (`desktop/verify_*.sh`, два реальных
экземпляра форка): E2E текст/группы/медиа, ротация ключей, safety numbers, TTL,
персист истории, @упоминания, папки, админка групп, опросы, стикеры — все проходят.

> **Основной клиент — веб** (`web/telegram-tt`, форк Telegram Web A на TypeScript):
> задеплоен на прод, ходит на `gateway` по WSS. Провайдер `src/api/parvane/`
> заменяет MTProto/GramJS; там же — русская локализация, «Избранное», контакты,
> папки, обои, QR, 2FA через Telegram-бота, лимиты частоты и сверка ключей.
>
> **Десктоп** (`desktop/`, форк Telegram Desktop, C++/Qt) доведён до паритета с
> вебом и ходит на прод по тому же WSS (`GatewayWsTransport`), вход по нику,
> Telegram-подтверждение/2FA. Лицензия унаследована от tdesktop — **GPLv3**.
>
> **Android** (`android/`) — шов TDLib: класс `org.drinkless.tdlib.Client` подменён
> shim'ом поверх `parvane-core` (JNI, `libparvane_jni.so`), объекты `TdApi`
> синтезируются из событий Parvane. Свой минимальный Compose-клиент (`android/app`)
> работает end-to-end (вход по нику/паролю, E2E-текст с десктопом/вебом);
> форк Telegram X (`setup-tgx.sh`, оверлей) собирается и стартует на том же шове —
> доводка приостановлена 8 сен 2026. Подробности и как возобновить —
> `android/BUILD-android.md`.
>
> Прежний самодельный Tauri-клиент (React 18, Gruvbox-TUI) архивирован в ветке
> **`tauri`**.
>
> **Состояние (общее для веба и десктопа):** мессенджер и звонки работают
> end-to-end поверх шардов. Сделано:
> - **Текст 1-на-1** (логин через `identity`, отправка/приём/sync) + **форматирование**
>   (жирный/курсив/моно/код/цитата/спойлер/ссылка — round-trip через `entities`).
> - **Медиа**: голосовые (с реальной формой волны), видео-кружочки, фото, видео,
>   файлы — в личке и в группах.
> - **Реакции, закреп, ответы, редактирование, удаление, пересылка, поиск,
>   аватары/имена, typing, online/last-seen**.
> - **Группы и каналы** (роли, права постинга, медиа/реакции/пин).
> - **Звонки**: реальный WebRTC (tg_owt) — аудио и видео, групповые (mesh);
>   свой аудио-модуль на **PulseAudio** (прибилженный tg_owt без ALSA/Pulse давал
>   тишину); защита от MITM (подпись SDP Ed25519 + SAS-эмодзи); **нативный экран
>   звонка** (`Ui::GL::Window` + родные виджеты `calls.style`), входящий с
>   «Ответить/Отклонить», рингтоны; **STUN/TURN** (свой сервер `infra/turn`).
> - **Безопасность инфраструктуры**: **TLS на NATS** (`PARVANE_NATS_TLS_CA`),
>   пароли **argon2id**.
>
> - **E2E-шифрование по умолчанию** (текст/медиа/группы, Olm+Megolm, sealed sender,
>   ротация ключей, safety numbers, TTL, локальный персист истории) — см. раздел выше.
> - **Опросы** (нативные CreatePollBox/лента; вопрос/варианты/голоса едут внутри
>   E2E-контента, агрегация на каждом клиенте, переживают рестарт) и **стикеры**
>   (локальные паки `~/.local/share/ParvaneStickers/<Пак>/*.webp|png` → нативная
>   панель; отправка/приём через E2E-блоб в `cloud`), GIF-приём с автоплеем.
>
> Проверено двумя реальными экземплярами (`desktop/run-live-demo.sh`,
> `desktop/verify_*.sh`). Батч паритета завершён; дальше — рескин (Фаза 5),
> Календарь/Дневник (Фаза 6), мелкие пробелы (анимированные стикеры,
> кастом-эмодзи, GIF-панель). Ботов/Stories/Premium — не делаем.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│  Клиенты: web (Telegram Web A, TS) · desktop (tdesktop, C++) ·   │
│           android (форк TDLib-клиента, в работе)                 │
│  У каждого сетевой слой Telegram заменён на наш (провайдер/        │
│  parvane-core); события Parvane маппятся в родные объекты клиента │
└────────────────────────────┬────────────────────────────────────┘
              прод: WSS через gateway (wss://host/ws)
              дев:  NATS напрямую (TCP :4222) или gateway TCP :9223
                             │
                       ┌─────▼──────────────────────────────────┐
                       │   gateway (JWT-auth, изоляция инбоксов, │
                       │   лимиты частоты; WS :9222 / TCP :9223) │
                       └─────┬───────────────────────────────────┘
                             │ NATS Core (TCP :4222)
                       ┌─────▼──────────────────────────────────┐
                       │              NATS (Core)                │
                       │  fire-and-forget, без JetStream         │
                       └─────┬────┬──────┬──────┬───────┬───────┘
                         identity  msg   file   note   cal   call
                             │     │      │      │      │      │
                         ┌───▼──┐┌─▼────┐┌──▼───┐┌──▼──┐┌──▼───┐┌──▼──┐
                         │iden- ││mes-  ││cloud ││notes││cal-  ││call │
                         │tity  ││senger││      ││     ││endar ││     │
                         └──┬───┘└─┬────┘└──┬───┘└──┬──┘└──┬───┘└──┬──┘
                         SQLite SQLite SQLite SQLite SQLite SQLite
```

> Медиа-блобы (голос/видео/фото/файлы) хранит шард `cloud`; сообщение в
> `messenger` несёт лишь `file_id` + метаданные. Звонки: `call` релеит
> WebRTC-сигналинг в персональный инбокс получателя `call.user.<id>`.

Три слоя:

1. **Шина** — Core NATS. Только доставка событий, без хранения.
2. **Шарды** — независимые Rust-сервисы. Каждый владеет своей SQLite и своей
   доменной логикой. Шарды не ходят в БД друг друга — только обмениваются
   событиями через шину.
3. **Клиенты** — форки зрелых клиентов Telegram с заменённым сетевым слоем.
   Веб (`web/`, форк Telegram Web A) — провайдер `src/api/parvane/` вместо
   MTProto/GramJS. Десктоп (`desktop/`, форк tdesktop) — модуль `parvane-core`
   (WSS/gateway или cnats) вместо MTProto, события маппятся в TL-объекты
   (`MTPMessage`/`MTPUser`) для штатного UI. Android (`android/`, в работе) —
   shim TDLib поверх `parvane-core`. Прод-подключение — через `gateway` по WSS.

---

## Стек

### Backend (шарды)

- **Язык**: Rust (edition 2021)
- **Async**: Tokio
- **Шина**: Core NATS через крейт `async-nats`
- **БД**: SQLite через `sqlx` (runtime-tokio, без макроса `query!`)
- **Миграции**: `sqlx::migrate!`
- **JWT**: `jsonwebtoken` (HS256)
- **Сериализация**: `serde` + `serde_json`
- **Логи**: `tracing` + `tracing-subscriber`
- **Ошибки**: `anyhow` в бинарниках

### Client (web) — форк Telegram Web A · ОСНОВНОЙ

- **База**: Telegram Web A (`web/telegram-tt`), TypeScript + собственный фреймворк Teact
- **Транспорт**: провайдер `src/api/parvane/` — WSS до `gateway`, заменяет MTProto/GramJS
- **Шов**: события Parvane ↔ объекты api-слоя Telegram Web A; UI без изменений
- **Своё**: русская локализация, «Избранное», контакты, папки, обои, QR, 2FA,
  лимиты частоты, сверка ключей безопасности
- **Деплой**: статика за Caddy, `wss://<host>/ws` (см. `infra/deploy`)

### Client (десктоп) — форк Telegram Desktop

- **База**: Telegram Desktop (`tdesktop`), C++ / Qt 6 (см. `desktop/UPSTREAM`)
- **Транспорт**: `parvane-core` — WSS до `gateway` (`GatewayWsTransport`, прод)
  либо cnats/NATS напрямую (дев); заменяет MTProto
- **Шов**: события Parvane ↔ TL-объекты (`MTPMessage`/`MTPUser`); UX tdesktop
  без изменений
- **Лицензия**: GPLv3 (с OpenSSL-исключением), унаследована от tdesktop

### Client (Android) — шов TDLib над parvane-core · ПРИОСТАНОВЛЕН (8 сен 2026)

- **Шов**: `android/libtd` — `TdApi.java` (бандл Telegram X, TDLib d1085f9),
  `Client.kt` (`create/send/execute/close`, авторизация: ник = поле «телефон» →
  пароль → `identity.token.issue`), `ParvaneStore.kt` (синтез Chat/User/Message),
  `ParvaneCore.kt` + `jni/parvane_jni.cpp` → `libparvane_jni.so` (сессия WSS,
  E2E, sealed-отправка, verifySender, sync/инбокс, resolve/search)
- **Свой клиент** `android/app` (Compose): вход, чаты, текст, «новый чат по нику»;
  APK arm64 ~11 МБ; дымовой тест в эмуляторе x86_64 `smoke_emulator.sh` — зелёный
- **Telegram X**: оверлей `setup-tgx.sh` на внешний клон; собирается (arm64/x64),
  стартует, экран входа по нику; дальше не доведено (падение хостового эмулятора
  на экране пароля; на телефоне не проверялось)
- **Лицензия**: свой клиент — как проект; форк Telegram X — GPLv3

> Прежний Tauri-клиент (React 18 + Babel-standalone, Gruvbox-TUI, Rust IPC-мост
> с 17 командами) сохранён в ветке **`tauri`**.

---

## Структура репозитория

```
Parvane/
├── Cargo.toml                  ← workspace (шарды)
├── README.md
├── CLAUDE.md
├── shared/
│   └── parvane-types/          ← общие типы, CRDT-типы, топики
├── shards/
│   ├── identity/
│   ├── messenger/
│   ├── cloud/
│   ├── notes/        (src/rga.rs — RGA CRDT)
│   ├── calendar/     (src/lww.rs — LWW-Map CRDT)
│   └── call/         (src/calls.rs — логика статусов)
├── web/                        ← ОСНОВНОЙ клиент — форк Telegram Web A (TS)
│   └── telegram-tt/
│       └── src/api/parvane/     ← провайдер: WSS/gateway вместо MTProto, локализация
├── desktop/                    ← клиент — форк Telegram Desktop (C++/Qt)
│   ├── UPSTREAM                ← тег + commit снапшота tdesktop
│   ├── BUILD-parvane.md        ← рецепт сборки (п.7 — запуск против прода по WSS)
│   ├── ARCHITECTURE-parvane.md ← шов врезки Parvane в tdesktop
│   ├── PARITY-telegram.md      ← карта паритета с Telegram
│   ├── parvane-core/           ← транспорт (WSS/cnats) + E2E + cloud + звонки, тесты
│   ├── tdesktop/               ← вендоренный снапшот форка
│   │   └── Telegram/SourceFiles/parvane/  ← parvane_client.{h,cpp}, intro_parvane
│   └── verify_*.sh             ← e2e-скрипты (два реальных экземпляра)
├── android/                    ← Android: шов TDLib над parvane-core (приостановлен)
│   ├── BUILD-android.md        ← тулчейн, стадии 1–3, как возобновить
│   ├── libtd/                  ← TdApi.java + Client.kt (shim) + ParvaneStore + ParvaneCore
│   ├── app/                    ← свой Compose-клиент (APK, дымовой тест зелёный)
│   ├── jni/                    ← CMake ядра (без cnats, WSS-only) + parvane_jni.cpp
│   ├── tgx-overlay/ · setup-tgx.sh · tgx_*.sh  ← форк Telegram X (оверлей, эмулятор)
│   └── build-openssl.sh · build-core.sh · smoke_emulator.sh
├── scripts/                    ← e2e веба (Playwright) и прод-смоук
└── infra/
    ├── nats/server.conf        ← ACL по ролям
    ├── deploy/                 ← docker compose + deploy.sh (прод за Caddy)
    ├── telegram-bot/           ← бот подтверждения регистрации (на VPS)
    └── turn/                   ← TURN/STUN для звонков
```

---

## Веб-клиент (основной, форк Telegram Web A)

Основной клиент — форк Telegram Web A в `web/telegram-tt`. Сетевой слой
(MTProto/GramJS) заменён провайдером `src/api/parvane/`, который ходит на
`gateway` по WSS и маппит события Parvane в объекты api-слоя Telegram Web A —
штатный UI без изменений. Там же: русская локализация, «Избранное», контакты,
папки, обои, QR, 2FA через Telegram-бота, лимиты частоты, сверка ключей.

```bash
cd web/telegram-tt
npm ci
npm run dev            # локально; адрес gateway задаётся в настройках/окружении
npm run check:ts       # типы; тесты — vitest; e2e — scripts/run_web_*_e2e.sh
```

Деплой на прод (статика за Caddy + `wss://<host>/ws`) — `infra/deploy`.

## Десктопный клиент (форк tdesktop)

Клиент — форк Telegram Desktop в `desktop/`. Сетевой слой MTProto заменён
модулем `desktop/parvane-core`; на проде транспорт — **WSS до `gateway`**
(`GatewayWsTransport`), в деве — cnats/NATS напрямую. События Parvane маппятся
в TL-объекты, которые потребляет штатный UI tdesktop. Подробности шва —
`desktop/ARCHITECTURE-parvane.md`, паритет — `desktop/PARITY-telegram.md`.

### Точки врезки в tdesktop

| Файл | Роль |
|---|---|
| `SourceFiles/parvane/parvane_client.{h,cpp}` | сессия шины, реестр пиров (`address↔id`, FNV-1a), отправка/приём, sync-таймер |
| `SourceFiles/intro/intro_parvane.cpp` | логин через `identity.token.issue`, синтез self как `MTPUser` |
| `apiwrap.cpp` | `ApiWrap::sendMessage` → `Parvane::MirrorOutgoing` → `msg.chat.send` |
| `main/main_session.cpp` | `Parvane::AfterSessionReady` — post-session хуки + старт sync |

Приём — pull: `msg.sync.request` → `msg.sync.response` → синтез `MTPMessage` →
`Data::Session::addNewMessage`. Триггеры: подписка на `msg.chat.delivered`
(«синкнись») + периодический `base::Timer`.

### Сборка и запуск

Рецепт сборки (тулчейн Qt6/OpenSSL/FFmpeg, шаги CMake/ninja) — в
`desktop/BUILD-parvane.md`. Бинарь — `desktop/build-probe/bin/Telegram`.
Сборка требует `-j6` (иначе OOM на 16 ГБ).

```bash
# headless-запуск (нужны живые identity + messenger, см. «Запуск»)
cd desktop/build-probe/bin
QT_QPA_PLATFORM=offscreen PARVANE_AUTOLOGIN='alice@local:test' \
  ./Telegram -workdir /tmp/parvane-fork
# логи tdesktop пишутся в <workdir>/log.txt, НЕ в stdout
```

Отладочные env-хуки: `PARVANE_AUTOLOGIN=user:password`,
`PARVANE_AUTOSEND=peer:текст`, `PARVANE_NATS_URL`.

### e2e-проверки

```bash
cd desktop
./verify_phase3b.sh        # отправка
./verify_phase3c.sh        # приём
./verify_phase3d.sh        # стартовый/периодический sync + список диалогов
./verify_two_instances.sh  # два реальных экземпляра форка одновременно (alice ↔ bob)
./verify_polls.sh          # опросы: создание → E2E-доставка → голос → агрегация → рестарт
./verify_stickers.sh       # стикеры: локальный пак → панель → E2E-отправка → приём
```

> Пользователи для e2e переопределяются: `A_USER=palice@local B_USER=pbob@local ./verify_polls.sh`
> (пароль `test`; регистрация — `nats req identity.user.register '{"user":"…","password":"test"}'`).

---

## Формат события

Любое событие на шине — JSON со стандартной обёрткой `ParvaneEvent<T>`:

```json
{
  "id": "0192...-uuid-v7",
  "from": "alice@local",
  "ts": 1718000000,
  "token": "<JWT>",
  "payload": { ... }
}
```

- `id` — UUID v7 (лексикографически сортируется по времени — используется в sync).
- `from` — отправитель `user@server`.
- `ts` — unix-время отправителя.
- `token` — JWT от identity. Пустая строка только для `identity.token.issue`.
- `payload` — доменная нагрузка, тип зависит от топика.

---

## Топики NATS

Соглашение: `{домен}.{ресурс}.{действие}`.

| Топик | Payload | Тип |
|---|---|---|
| `identity.token.issue` | `IssueRequest` → `IssueResponse` | request/reply |
| `identity.token.verify` | `VerifyRequest` → `VerifyResponse` | request/reply |
| `msg.chat.send` | `SendPayload { to, content: MessageContent }` | publish |
| `msg.chat.delivered` | `DeliveredPayload` | publish (от шарда) |
| `msg.chat.read` | `ReadPayload` | publish |
| `msg.sync.request` | `SyncRequestPayload` → `SyncResponsePayload` | request/reply |
| `file.upload.chunk` | `UploadChunkPayload` | publish |
| `file.upload.complete` | `UploadCompletePayload` → `UploadCompleteResponse` | request/reply |
| `file.download.request` | `DownloadRequest` → чанки `DownloadResponse` | request/reply |
| `file.list.request` | `FileListPayload` → `FileListResponse` | request/reply |
| `note.create` / `note.update` / `note.delete` | `NoteCreate/Update/DeletePayload` | publish |
| `note.sync.request` | `NoteSyncRequestPayload { known }` → `NoteSyncResponsePayload` (diff) | request/reply |
| `cal.event.create` / `cal.event.update` / `cal.event.delete` | `CalSetPayload` / `CalDeletePayload` | publish |
| `cal.sync.request` | `CalSyncRequestPayload { known }` → `CalSyncResponsePayload` (diff) | request/reply |
| `call.signal` | `CallSignalPayload` (invite/answer/reject/ice/hangup) | publish |
| `call.user.<id>` | `CallSignal` — релей в инбокс получателя | publish (от шарда) |
| `call.history.request` | `{}` → `CallHistoryResponse` | request/reply |

### Медиа в сообщениях

`msg.chat.send` несёт `content: MessageContent` — тегированный enum по полю `kind`:

| `kind` | Поля |
|---|---|
| `text` | `text` |
| `voice` | `file_id`, `duration_secs`, `mime`, `size_bytes` |
| `video_note` | `file_id`, `duration_secs`, `mime`, `size_bytes` |
| `photo` | `file_id`, `width`, `height`, `mime`, `size_bytes`, `caption?` |
| `video` | `file_id`, `duration_secs`, `width`, `height`, `mime`, `size_bytes`, `caption?` |
| `file` | `file_id`, `filename`, `mime`, `size_bytes`, `caption?` |

Медиа-поток: клиент грузит файл в `cloud` (`file.upload.chunk` × N → `file.upload.complete`
⇒ `file_id`), затем шлёт сообщение со ссылкой. Получатель скачивает через `file.download.request`.

### Звонки (сигналинг)

Backend **релеит** WebRTC-сигналы и ведёт историю. Вызывающий шлёт `call.signal`
→ шард `call` проверяет JWT, пишет запись (`ringing`) и публикует сигнал в инбокс
`call.user.<callee>`. Статусы: `ringing → answered → ended` (или `missed` / `rejected`).
Реальный медиа-поток идёт P2P через WebRTC — мимо шины.

---

## Авторизация

Двухуровневая:

1. **NATS ACL** (`infra/nats/server.conf`) — каждый компонент подключается своим
   пользователем и имеет права только на нужные топики.
2. **JWT внутри события** — шард извлекает `token` из события, спрашивает
   `identity.token.verify`, получает `user` (subject токена) и сверяет с `from`.
   Доменные правила применяются поверх: только владелец может редактировать свои
   заметки/события.

Identity генерирует keypair (Ed25519) при первом старте (хранит в SQLite), JWT
подписывается им (TTL 24 часа). Пароли — **argon2id**. Регистрация и вход
разделены (`identity.user.register` / `identity.token.issue`).

---

## Офлайн-модель и синхронизация

Протокол синхронизации (шарды отдают только **расхождение**, а не весь набор):

- **messenger** (append-only): курсор = max `id` у клиента → шард возвращает
  сообщения с `id > cursor` (UUID v7 лексикографически сортируем по времени).
  Новое дописывается с дедупом по `id`. (Форк-клиент сейчас делает полный
  ресинк `since=0` с дедупом по UUID; дисковый курсор — в планах.)
- **notes / calendar** (изменяемые): diff по **контрольным суммам**. Клиент шлёт
  манифест `{id → checksum}` (FNV-1a, считается одинаково на шарде и в клиенте —
  `parvane_types::content_checksum` / `event_checksum`). Шард возвращает только
  заметки/события, чья сумма разошлась или которых клиент не знает, плюс
  tombstone'ы удалённых. Неизменившееся не передаётся вовсе.

Сохранение заметки — одна операция `NoteOp::Replace { text }`: клиент источник
истины для тела, шард атомарно сносит и пересобирает RGA-узлы. Это делает
сохранение детерминированным независимо от состояния клиентского кеша.

---

## CRDT

### Заметки — RGA (`shards/notes/src/rga.rs`)

Текстовый CRDT. Каждый символ — узел с уникальным `OpId{seq, site}` и ссылкой
`after`. Вставки и удаления (tombstone) коммутируют. Видимый текст — preorder-обход,
сиблинги упорядочены по `OpId` убыванием. Обход итеративный (не рекурсивный — длинный
текст = переполнение стека при рекурсии).

### Календарь — per-field LWW-Map (`shards/calendar/src/lww.rs`)

Событие — набор полей, каждое со своим LWW-регистром `(value, Stamp{ts, site})`.
Конкурентные правки разных полей сливаются; одного поля — побеждает больший `ts`
(`site` разрывает ничью). Правка новее delete-штампа «воскрешает» событие.

---

## Требования

- Rust ≥ 1.80 (бэкенд-шарды)
- nats-server ≥ 2.10
- nats CLI (для ручного тестирования)
- Node ≥ 20 + npm — для веб-клиента (`web/telegram-tt`, `npm ci && npm run dev`)
- Тулчейн tdesktop (Qt 6, OpenSSL, FFmpeg, CMake/ninja) — для десктоп-клиента,
  см. `desktop/BUILD-parvane.md`
- Android NDK + `cargo-ndk` + Rust android-таргеты — для `parvane-core` под
  Android, см. `android/BUILD-android.md` (Android-клиент в работе)

### Установка NATS (без прав root)

```bash
# nats-server
curl -sL https://github.com/nats-io/nats-server/releases/download/v2.10.24/nats-server-v2.10.24-linux-amd64.tar.gz \
  | tar -xz -C /tmp && mv /tmp/nats-server-*/nats-server ~/.local/bin/

# nats CLI
curl -sL https://github.com/nats-io/natscli/releases/download/v0.1.6/nats-0.1.6-linux-amd64.zip -o /tmp/nats.zip \
  && cd /tmp && unzip -q nats.zip && mv nats-*/nats ~/.local/bin/
```

---

## Сборка

```bash
# Все шарды
cargo build

# Один шард
cargo build -p messenger

# Клиент (форк tdesktop) — рецепт в desktop/BUILD-parvane.md (нужен -j6)
```

---

## Запуск

В отдельных терминалах (или через `nohup ... &`):

```bash
# 1. Шина
nats-server

# 2. Identity (нужен всем шардам для проверки JWT)
cargo run -p identity

# 3. Доменные шарды
PARVANE_DB_PATH=/tmp/messenger.db cargo run -p messenger
PARVANE_DB_PATH=/tmp/cloud.db     cargo run -p cloud
PARVANE_DB_PATH=/tmp/notes.db     cargo run -p notes
PARVANE_DB_PATH=/tmp/calendar.db  cargo run -p calendar
PARVANE_DB_PATH=/tmp/call.db      cargo run -p call

# 4. Клиент (форк tdesktop) — см. desktop/BUILD-parvane.md
cd desktop/build-probe/bin && QT_QPA_PLATFORM=offscreen \
  PARVANE_AUTOLOGIN='alice@local:test' ./Telegram -workdir /tmp/parvane-fork
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PARVANE_NATS_URL` | `nats://localhost:4222` | адрес шины |
| `PARVANE_DB_PATH` | `./<shard>.db` | путь к SQLite |
| `PARVANE_LOG_LEVEL` | `info` | уровень логов |

> ⚠️ `PARVANE_DB_PATH` относителен рабочему каталогу запуска. Используй абсолютный
> путь или `/tmp/<shard>.db`.

---

## Тестирование

### Unit-тесты

```bash
cargo test --workspace        # все 47
cargo test -p notes           # RGA CRDT
cargo test -p calendar        # LWW CRDT
cargo test -p messenger       # логика мессенджера
cargo test -p call            # переходы статуса звонка
```

### Ручной прогон через nats CLI

```bash
# Получить JWT
TOKEN=$(nats req identity.token.issue '{"user":"alice@local","password":"secret"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# ── Мессенджер ─────────────────────────────────────────────────
# Отправить текст alice → bob
nats pub msg.chat.send \
  "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$(date +%s),\
\"token\":\"$TOKEN\",\"payload\":{\"to\":\"bob@local\",\
\"content\":{\"kind\":\"text\",\"text\":\"привет\"}}}"

# Синхронизация пропущенных
TOKEN_BOB=$(nats req identity.token.issue '{"user":"bob@local","password":"pass"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
nats req msg.sync.request \
  "{\"id\":\"$(uuidgen)\",\"from\":\"bob@local\",\"ts\":$(date +%s),\
\"token\":\"$TOKEN_BOB\",\"payload\":{\"last_seen_id\":\"00000000-0000-0000-0000-000000000000\"}}"

# ── Notes ───────────────────────────────────────────────────────
NOTE_ID=$(uuidgen)
nats pub note.create \
  "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$(date +%s),\
\"token\":\"$TOKEN\",\"payload\":{\"note_id\":\"$NOTE_ID\",\"title\":\"Заметка\"}}"
nats req note.sync.request \
  "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$(date +%s),\
\"token\":\"$TOKEN\",\"payload\":{}}"

# ── Calendar ────────────────────────────────────────────────────
EV_ID=$(uuidgen); NOW=$(date +%s)
nats pub cal.event.create \
  "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$NOW,\
\"token\":\"$TOKEN\",\"payload\":{\"event_id\":\"$EV_ID\",\
\"fields\":{\"title\":\"Встреча\",\"start\":\"$NOW\"},\
\"stamp\":{\"ts\":$NOW,\"site\":\"alice@local\"}}}"

# ── Cloud ───────────────────────────────────────────────────────
nats req file.list.request \
  "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$(date +%s),\
\"token\":\"$TOKEN\",\"payload\":{}}"

# ── Звонки ──────────────────────────────────────────────────────
# Подписаться на инбокс получателя в отдельном терминале:
nats sub "call.user.bob@local"
# Отправить invite:
nats pub call.signal \
  "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$(date +%s),\
\"token\":\"$TOKEN\",\"payload\":{\"to\":\"bob@local\",\
\"signal\":{\"type\":\"invite\",\"call_id\":\"$(uuidgen)\",\
\"media\":\"audio\",\"sdp\":\"<offer>\"}}}"
# История:
nats req call.history.request \
  "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$(date +%s),\
\"token\":\"$TOKEN\",\"payload\":{}}"
```

> ⚠️ Проверка JWT через identity занимает ~0.5 с. При скриптовом тестировании
> ставь паузу ≥ 1.5 с перед `sync.request`.

---

## Соглашения по коду

- Порядок старта шарда: `tracing` → SQLite + миграции → NATS → подписки.
- Ошибки — через `tracing::error!`. Паника в проде запрещена.
- Все топики — константы в `parvane-types::topics`, не строки в коде шардов.
- Чистая доменная логика (CRDT) — в отдельных модулях без async/IO, покрыта тестами.
- `sqlx::query_as` вместо `sqlx::query!` (не требует `DATABASE_URL` на этапе компиляции).

---

## Известные ограничения

- Федерация (`fed.*`, leaf nodes) — «North Star», пока не реализована.
- `smarthome` заморожен.
- Свои исходящие sealed после релогина — восстанавливаются из локального журнала
  истории (на сервере их как «своих» нет — by design sealed sender).
- **Android-клиент в работе**: `parvane-core` собирается под NDK; JNI-shim TDLib,
  установка SDK/JDK и сам UI — впереди (см. `android/BUILD-android.md`).
- Календарь/Дневник (шарды `notes`/`calendar` есть, к UI клиентов не подключены)
  — впереди.
- `notes`/`calendar` шарды на прод не разворачиваются (пока не нужны клиентам).
