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
| `gateway` | Единая доверенная точка входа (TCP/WS), JWT-auth, изоляция инбоксов | ✅ готов |
| `client` (`desktop/`) | Десктопный клиент — форк Telegram Desktop | ✅ мессенджер + звонки + **E2E по умолчанию** (текст/медиа/группы), паритет-фичи; рескин и Календарь/Дневник — впереди |
| `smarthome` | Умный дом, RBAC по устройствам | ⛔ заморожен |

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
**черновики**, **админка групп** (роли, add/kick, выйти). Из паритета осталось:
опросы, стикеры/GIF (см. `desktop/PARITY-telegram.md`).

**Тесты:** unit-тесты бэкенда (`cargo test --workspace`, включая argon2 и
crypto vodozemac) + слой `parvane-core` клиента (transport, messenger, crypto/SAS,
call, group…) — все зелёные. Живые e2e (`desktop/verify_*.sh`, два реальных
экземпляра форка): E2E текст/группы/медиа, ротация ключей, safety numbers, TTL,
персист истории, @упоминания, папки, админка групп — все проходят.

> **Пивот клиента (июнь 2026).** Самодельный Tauri-клиент (React 18 +
> Babel-standalone, Gruvbox-TUI) сохранён в ветке **`tauri`** и остаётся рабочим.
> Дальнейший клиент строится как **форк Telegram Desktop** (`tdesktop`, C++/Qt) в
> каталоге `desktop/`: зрелый UX переключается с MTProto на наш бэкенд (NATS +
> Rust-шарды через NATS C-клиент `cnats`), затем перекрашивается под TUI/Gruvbox;
> КАЛЕНДАРЬ и ДНЕВНИК добавляются после готового мессенджера. Форк наследует
> лицензию tdesktop — **GPLv3** (с OpenSSL-исключением).
>
> **Состояние форка:** мессенджер и звонки работают end-to-end поверх шардов.
> Сделано:
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
>
> Проверено двумя реальными экземплярами (`desktop/run-live-demo.sh`,
> `desktop/verify_*.sh`). Дальше — опросы и стикеры (пробелы паритета из
> `desktop/PARITY-telegram.md`), рескин (Фаза 5), Календарь/Дневник (Фаза 6).
> Ботов/Stories/Premium — не делаем.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│            Desktop client — форк Telegram Desktop (C++/Qt)        │
│  parvane-core: cnats + nlohmann/json вместо MTProto              │
│  ──────────────────────────────────────────────────────────     │
│  Transport/MessengerClient → NATS напрямую (как обычный шард)    │
└────────────────────────────┬────────────────────────────────────┘
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
3. **Клиент** — форк Telegram Desktop (C++/Qt). Модуль `parvane-core`
   (cnats + nlohmann/json) подключается к NATS как обычный шард вместо MTProto;
   события Parvane маппятся в TL-объекты (`MTPMessage`/`MTPUser`), которые
   читает штатный UI tdesktop.

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

### Client (десктоп) — форк Telegram Desktop

- **База**: Telegram Desktop (`tdesktop`), C++ / Qt 6 (см. `desktop/UPSTREAM`)
- **Транспорт**: `parvane-core` — cnats (NATS C-клиент) + nlohmann/json,
  заменяет MTProto
- **Шов**: события Parvane ↔ TL-объекты (`MTPMessage`/`MTPUser`); UX tdesktop
  без изменений
- **Лицензия**: GPLv3 (с OpenSSL-исключением), унаследована от tdesktop

> Прежний Tauri-клиент (React 18 + Babel-standalone, Gruvbox-TUI, Rust IPC-мост
> с 17 командами) сохранён в ветке **`tauri`** и остаётся полностью рабочим.

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
├── desktop/                    ← форк-клиент (прежний Tauri-клиент — в ветке tauri)
│   ├── UPSTREAM                ← тег + commitснапшота tdesktop
│   ├── BUILD-parvane.md        ← воспроизводимый рецепт сборки
│   ├── ARCHITECTURE-parvane.md ← шов врезки Parvane в tdesktop
│   ├── PHASE3-progress.md      ← журнал ядра мессенджера
│   ├── parvane-core/           ← Transport + MessengerClient (cnats), тесты
│   ├── tdesktop/               ← вендоренный снапшот форка
│   │   └── Telegram/SourceFiles/parvane/  ← parvane_client.{h,cpp}, intro_parvane
│   └── verify_phase3{b,c,d}.sh · verify_two_instances.sh  ← e2e-скрипты
└── infra/
    └── nats/
        └── server.conf         ← ACL по ролям
```

---

## Десктопный клиент (форк tdesktop)

Клиент — форк Telegram Desktop в `desktop/`. Сетевой слой MTProto заменён
модулем `desktop/parvane-core` (cnats + nlohmann/json), события Parvane
маппятся в TL-объекты, которые потребляет штатный UI tdesktop. Подробности
шва — `desktop/ARCHITECTURE-parvane.md`, журнал работ — `desktop/PHASE3-progress.md`.

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
```

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
- Тулчейн tdesktop (Qt 6, OpenSSL, FFmpeg, CMake/ninja) — для сборки клиента,
  см. `desktop/BUILD-parvane.md`

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
- TTL самоуничтожения — пока только для текста (медиа-инъекция ttl не прокидывает).
- Свои исходящие sealed после релогина — восстанавливаются из локального журнала
  истории (на сервере их как «своих» нет — by design sealed sender).
- Из паритета Telegram осталось: опросы, стикеры/GIF/кастом-эмодзи.
- Рескин под Gruvbox (Фаза 5) и Календарь/Дневник (Фаза 6, шарды `notes`/`calendar`
  есть, к UI не подключены) — впереди.
