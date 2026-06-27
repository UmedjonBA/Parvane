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
| `client` | Десктопное приложение Tauri v2 | ✅ готов |
| `smarthome` | Умный дом, RBAC по устройствам | ⛔ заморожен |

**Тесты:** 47 unit-тестов (`cargo test --workspace`) — все зелёные.

Мессенджер поддерживает 1-на-1 переписку с текстом и медиа (голосовые, видео-
кружочки, фото, видео, файлы) и аудио/видео-звонки на уровне сигналинга. Запись и
воспроизведение медиа, а также реальный WebRTC-поток — задача клиента.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tauri desktop client                          │
│  React 18 + Babel-standalone · Gruvbox dark · 7 экранов         │
│  ──────────────────────────────────────────────────────────     │
│  Rust IPC-мост: 17 команд → NATS (как обычный шард)             │
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
3. **Клиент** — Tauri v2 десктоп-приложение. Rust-мост подключается к NATS как
   обычный шард и отдаёт фронтенду 17 IPC-команд.

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

### Client (десктоп)

- **Фреймворк**: Tauri v2
- **UI**: React 18 + Babel-standalone (JSX в браузере, без сборки)
- **Стиль**: Gruvbox dark, CSS custom properties
- **IPC**: `window.__TAURI__.core.invoke()` → Rust-команды

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
├── client/
│   ├── index.html              ← точка входа фронтенда
│   ├── src/
│   │   ├── live.jsx            ← IPC-мост + React-хуки
│   │   ├── app.jsx             ← LoginScreen + маршрутизация
│   │   ├── shell.jsx           ← шапка, вкладки, футер
│   │   ├── atoms.jsx           ← переиспользуемые компоненты
│   │   ├── data.jsx            ← демо-данные (fallback без бэкенда)
│   │   └── screens/
│   │       ├── messenger.jsx
│   │       ├── notes.jsx
│   │       ├── calendar.jsx
│   │       ├── cloud.jsx
│   │       ├── system.jsx
│   │       ├── diary.jsx
│   │       └── home.jsx
│   └── src-tauri/
│       ├── Cargo.toml          ← изолированный workspace клиента
│       ├── tauri.conf.json
│       └── src/lib.rs          ← 17 IPC-команд → NATS
└── infra/
    └── nats/
        └── server.conf         ← ACL по ролям
```

---

## Десктопный клиент

### IPC-команды (client/src-tauri/src/lib.rs)

| Команда | Описание |
|---|---|
| `nats_status` | bool — подключён ли мост к NATS |
| `current_user` | текущий пользователь или null |
| `login(user, password)` | вход / авто-регистрация |
| `logout` | выход, очистка токена |
| `get_conversations` | список бесед с последним сообщением |
| `get_messages(peer)` | история переписки с конкретным собеседником |
| `send_text(to, text)` | отправить текстовое сообщение |
| `sync_messages(since)` | новые сообщения с момента last_seen |
| `list_notes` | все заметки пользователя (NoteSnapshot) |
| `create_note(title)` | создать заметку, возвращает note_id |
| `save_note(note_id, title, body)` | сохранить (RGA diff: delete old + insert new) |
| `delete_note(note_id)` | удалить заметку |
| `list_events` | все события календаря (CalEventSnapshot) |
| `create_event(fields)` | создать событие (title, start, end, location?) |
| `update_event_field(event_id, field, value)` | обновить одно поле |
| `delete_event(event_id)` | удалить событие |
| `list_files` | список файлов в облаке |
| `call_history` | история звонков |

> **Важно для Tauri v2**: многословные имена параметров (`last_seen_id`, `lastSeenId`)
> молча теряются в invoke(). Всегда используйте односложные имена (`since`, `peer`, …).

### React-хуки (client/src/live.jsx)

```javascript
useLiveStatus()          // bool | null — NATS подключён?
useLiveUser()            // [user, setUser] — текущий пользователь
useLiveConversations()   // { convs, loading, refresh }
useLiveChat(me, peer)    // { messages, ready, error, send }
useLiveNotes()           // { notes, loading, saving, refresh, create, save, remove }
useLiveCalendar()        // { events, loading, refresh, create, update, remove }
useLiveFiles()           // { files, loading, refresh }
useLiveCallHistory()     // { calls, loading, refresh }
```

### Сборка и запуск клиента

```bash
# Зависимости (Arch Linux)
sudo pacman -S webkit2gtk-4.1

# Установить Tauri CLI
cargo install tauri-cli

# Быстрая сборка (без бандлинга в .deb/.rpm)
cd client
cargo tauri build --no-bundle

# Запуск собранного бинаря
./src-tauri/target/release/monolith-client
```

Перед запуском клиента нужны запущенные бэкенд-шарды (см. раздел «Запуск»).
Авто-логин: при первом входе через UI данные сохраняются в `localStorage` и
восстанавливаются при следующем запуске.

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
| `note.sync.request` | `{}` → `NoteSyncResponsePayload` | request/reply |
| `cal.event.create` / `cal.event.update` / `cal.event.delete` | `CalSetPayload` / `CalDeletePayload` | publish |
| `cal.sync.request` | `{}` → `CalSyncResponsePayload` | request/reply |
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

Identity генерирует 256-битный секрет при первом старте (хранит в SQLite). JWT —
HS256, TTL 24 часа.

> ⚠️ Для прототипа пароли хешируются упрощённо. Перед продакшеном — argon2 +
> асимметричная подпись.

---

## Офлайн-модель и синхронизация

- **messenger**: `last_seen_id` → шард возвращает сообщения с `id > last_seen_id`
  (UUID v7 лексикографически сортируем по времени).
- **notes / calendar**: sync отдаёт полное состояние. Корректно, так как merge у
  CRDT идемпотентен.

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

- Rust ≥ 1.80
- nats-server ≥ 2.10
- nats CLI (для ручного тестирования)
- webkit2gtk-4.1 (для сборки Tauri-клиента, только Linux)

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

# Клиент (Tauri)
cd client && cargo tauri build --no-bundle
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

# 4. Клиент
./client/src-tauri/target/release/monolith-client
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

- Федерация (`fed.*`, leaf nodes) не реализована.
- Пароли хешируются упрощённо; JWT на симметричном HS256.
- `smarthome` заморожен.
- Read receipts мессенджера сохраняются, но пока не отдаются в `sync.response`.
- ACL в `server.conf` есть, но по умолчанию шарды стартуют без авторизации NATS.
- Запись/воспроизведение медиа и реальный WebRTC-поток (аудио/видео) не реализованы —
  ждут клиентской интеграции.
