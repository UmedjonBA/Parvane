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
| `messenger` | Сообщения, доставка, прочтение, офлайн-синхронизация | ✅ готов |
| `cloud` | Загрузка/скачивание файлов чанками | ✅ готов |
| `notes` | Заметки, текстовый CRDT (RGA) | ✅ готов |
| `calendar` | События, CRDT (per-field LWW) | ✅ готов |
| `smarthome` | Умный дом, RBAC по устройствам | ⛔ не реализован |
| Клиент (Tauri) | Десктоп-приложение | ⛔ не реализован |

**Тесты:** 31 unit-тест (`cargo test --workspace`) + ручные интеграционные
прогоны через `nats` CLI.

---

## Архитектура

```
                    ┌─────────────────────────────────────┐
                    │            NATS (Core)               │
                    │   шина: fire-and-forget, без         │
                    │   персистентности, без JetStream     │
                    └───┬─────┬─────┬─────┬─────┬───────────┘
        identity.*  ┌───┘ msg.*│file.│note.│cal. │
                    │         │ *   │ *   │ *   │
              ┌─────▼──┐ ┌────▼───┐ ┌▼────┐ ┌▼─────┐ ┌▼────────┐
              │identity│ │messenger│ │cloud│ │notes │ │calendar │
              └───┬────┘ └────┬───┘ └─┬───┘ └──┬───┘ └────┬────┘
                  │SQLite     │SQLite │SQLite  │SQLite    │SQLite
              identity.db  messenger.db cloud.db notes.db calendar.db
```

Три слоя замысла:

1. **Шина** — Core NATS. Только доставка событий, без хранения.
2. **Шарды** — независимые Rust-сервисы. Каждый владеет своей SQLite и своей
   доменной логикой. Шарды не ходят в БД друг друга — только обмениваются
   событиями через шину.
3. **Клиент** — Tauri-приложение (ещё не реализовано).

Федерация между серверами задумана через NATS leaf node и префикс топиков
`fed.*`, но пока не реализована.

### Почему так

- **Изоляция отказов**: упавший шард не роняет остальные.
- **Простая модель данных**: каждый шард — маленькое самодостаточное приложение.
- **Слабая связанность**: шарды знают только про топики и формат событий, не про
  внутренности друг друга. Единственная межсервисная зависимость — все шарды
  спрашивают `identity` про валидность JWT.

---

## Стек

- **Язык**: Rust (edition 2021)
- **Async**: Tokio
- **Шина**: Core NATS через крейт `async-nats`
- **БД**: SQLite через `sqlx` (runtime-tokio)
- **Миграции**: `sqlx::migrate!` (встраиваются в бинарник на этапе компиляции)
- **JWT**: `jsonwebtoken` (алгоритм HS256, секрет генерируется identity при старте)
- **Сериализация**: `serde` + `serde_json`
- **Логи**: `tracing` + `tracing-subscriber` (pretty-формат в терминал)
- **Ошибки**: `anyhow` в бинарниках, `thiserror` — для библиотечных крейтов

---

## Структура репозитория

```
Parvane/
├── Cargo.toml                  ← workspace
├── README.md
├── CLAUDE.md                   ← гайд для AI-ассистента
├── shared/
│   └── parvane-types/          ← общие типы (события, payload'ы, CRDT, топики)
├── shards/
│   ├── identity/               ← JWT issue/verify
│   ├── messenger/              ← чат + офлайн-очередь
│   ├── cloud/                  ← файлы чанками
│   ├── notes/
│   │   └── src/rga.rs          ← RGA CRDT (чистая логика + тесты)
│   └── calendar/
│       └── src/lww.rs          ← LWW-Map CRDT (чистая логика + тесты)
└── infra/
    └── nats/
        └── server.conf         ← NATS с ACL по ролям
```

Каждый шард — отдельный Cargo-пакет с бинарником `src/main.rs` и каталогом
`migrations/`.

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

- `id` — UUID v7 (лексикографически сортируется по времени — это используется в sync).
- `from` — отправитель `user@server`.
- `ts` — unix-время отправителя.
- `token` — JWT, выданный identity. Пустая строка только для `identity.token.issue`.
- `payload` — доменная нагрузка, тип зависит от топика.

---

## Топики NATS

Соглашение: `{домен}.{ресурс}.{действие}`.

| Топик | Payload | Тип запроса |
|---|---|---|
| `identity.token.issue` | `IssueRequest` → `IssueResponse` | request/reply |
| `identity.token.verify` | `VerifyRequest` → `VerifyResponse` | request/reply |
| `msg.chat.send` | `SendPayload` | publish |
| `msg.chat.delivered` | `DeliveredPayload` | publish (от шарда) |
| `msg.chat.read` | `ReadPayload` | publish |
| `msg.sync.request` | `SyncRequestPayload` → `SyncResponsePayload` | request/reply |
| `file.upload.chunk` | `UploadChunkPayload` | publish |
| `file.upload.complete` | `UploadCompletePayload` → `UploadCompleteResponse` | request/reply |
| `file.download.request` | `DownloadRequest` → `DownloadResponse` (стрим чанков) | request/reply |
| `note.create` / `note.update` / `note.delete` | `NoteCreate/Update/Delete` | publish |
| `note.sync.request` | `{}` → `NoteSyncResponsePayload` | request/reply |
| `cal.event.create` / `cal.event.update` / `cal.event.delete` | `CalSet/Delete` | publish |
| `cal.sync.request` | `{}` → `CalSyncResponsePayload` | request/reply |

Все типы payload'ов определены в `shared/parvane-types/src/lib.rs`.

---

## Авторизация

Двухуровневая:

1. **NATS ACL** (`infra/nats/server.conf`) — каждый компонент (identity,
   messenger, cloud, client, dev) подключается своим пользователем и имеет права
   только на нужные топики.
2. **JWT внутри события** — шард, получив событие, извлекает `token` и
   спрашивает identity через `identity.token.verify`. Identity возвращает
   `user` (subject токена). Шард сверяет его с заявленным `from` и применяет
   доменные правила (например, «редактировать заметку может только владелец»).

Identity при первом старте генерирует случайный 256-битный секрет и хранит его в
своей SQLite. JWT подписывается этим секретом (HS256), срок жизни — 24 часа.

> ⚠️ Для прототипа пароли хешируются упрощённо (не argon2), а JWT использует
> симметричный HS256. Перед продакшеном — заменить на argon2 + асимметричную
> подпись.

---

## Офлайн-модель и синхронизация

Каждый шард хранит все свои события в SQLite. Когда клиент возвращается в сеть,
он публикует `{домен}.sync.request`, а шард отвечает пропущенным:

- **messenger**: клиент шлёт `last_seen_id`; шард возвращает сообщения, где
  `to_user = я` и `id > last_seen_id` (UUID v7 даёт порядок по времени).
- **notes / calendar**: sync отдаёт полное состояние всех объектов пользователя.
  Это корректно, потому что merge у CRDT идемпотентен — повторная доставка
  ничего не ломает.

---

## CRDT: как разрешаются конфликты офлайн-правок

Заметки и календарь спроектированы так, чтобы правки с нескольких устройств
сходились к одному результату независимо от порядка доставки.

### Заметки — RGA (`shards/notes/src/rga.rs`)

Текстовый CRDT. Каждый символ — узел с уникальным `OpId{seq, site}` и ссылкой
`after` на предшественника. Вставки и удаления (tombstone) коммутируют. Видимый
текст — preorder-обход дерева «вставлен после», сиблинги упорядочены по `OpId`
убыванием. Проверено: доставка потомков раньше корня и конкурентные вставки в
одну позицию сходятся.

### Календарь — per-field LWW-Map (`shards/calendar/src/lww.rs`)

Событие — набор полей, каждое со своим LWW-регистром `(value, Stamp{ts, site})`.
Конкурентные правки разных полей сливаются без потерь; одного поля — побеждает
больший `ts` (`site` разрывает ничью). Удаление — отдельный штамп; правка новее
delete «воскрешает» событие.

---

## Требования

- **Rust** ≥ 1.80 (`rustc --version`)
- **nats-server** ≥ 2.10
- **nats CLI** (для ручного тестирования)

### Установка NATS (без прав root, в `~/.local/bin`)

```bash
# nats-server
curl -sL https://github.com/nats-io/nats-server/releases/download/v2.10.24/nats-server-v2.10.24-linux-amd64.tar.gz \
  | tar -xz -C /tmp && mv /tmp/nats-server-*/nats-server ~/.local/bin/

# nats CLI
curl -sL https://github.com/nats-io/natscli/releases/download/v0.1.6/nats-0.1.6-linux-amd64.zip -o /tmp/nats.zip
cd /tmp && unzip -q nats.zip && mv nats-*/nats ~/.local/bin/
```

---

## Сборка

```bash
cargo build              # все шарды
cargo build -p messenger # отдельный шард
```

---

## Запуск

В отдельных терминалах:

```bash
# 1. Шина
nats-server                       # слушает localhost:4222
# (или с ACL:  nats-server -c infra/nats/server.conf)

# 2. Identity — нужен всем остальным шардам для проверки JWT
cargo run -p identity

# 3. Любой доменный шард
cargo run -p messenger
cargo run -p cloud
cargo run -p notes
cargo run -p calendar
```

### Переменные окружения

Каждый шард читает (можно через `.env` в рабочем каталоге):

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PARVANE_NATS_URL` | `nats://localhost:4222` | адрес шины |
| `PARVANE_DB_PATH` | `./<shard>.db` | путь к файлу SQLite |
| `PARVANE_LOG_LEVEL` | `info` | уровень логов (`debug`, `info`, …) |

> ⚠️ `PARVANE_DB_PATH` относителен **рабочему каталогу**. Запускай каждый шард из
> его каталога или задавай абсолютный путь, иначе все базы лягут в одно место:
> `PARVANE_DB_PATH=/tmp/messenger.db cargo run -p messenger`.

---

## Тестирование

### Unit-тесты

```bash
cargo test --workspace        # все
cargo test -p notes           # CRDT заметок (RGA)
cargo test -p calendar        # CRDT календаря (LWW)
cargo test -p messenger       # логика мессенджера
```

### Ручной прогон через `nats` CLI

Запусти `nats-server`, `identity` и нужный доменный шард, затем:

```bash
# Получить JWT
TOKEN=$(nats req identity.token.issue '{"user":"alice@local","password":"secret"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")

# ── Мессенджер ───────────────────────────────────────────────
# Отправить сообщение alice → bob
nats pub msg.chat.send "{\"id\":\"$(uuidgen)\",\"from\":\"alice@local\",\"ts\":$(date +%s),\"token\":\"$TOKEN\",\"payload\":{\"to\":\"bob@local\",\"text\":\"привет\"}}"

# Bob забирает пропущенное
TOKEN_BOB=$(nats req identity.token.issue '{"user":"bob@local","password":"pass"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
nats req msg.sync.request "{\"id\":\"$(uuidgen)\",\"from\":\"bob@local\",\"ts\":$(date +%s),\"token\":\"$TOKEN_BOB\",\"payload\":{\"last_seen_id\":\"00000000-0000-0000-0000-000000000000\"}}"

# Подсмотреть все события чата
nats sub "msg.>"
```

Примеры для cloud, notes и calendar — в соответствующих разделах истории
разработки; формат событий тот же (`ParvaneEvent<T>` с нужным payload).

> ⚠️ Проверка JWT через identity занимает ~0.5 c. При скриптовом тестировании
> ставь паузу ≥ 1.5 c перед `sync.request`, иначе ответ отразит ещё не
> обработанные publish-события.

---

## Соглашения по коду

- Порядок старта шарда: `tracing` → SQLite + миграции → NATS → подписки.
- Ошибки — через `tracing::error!`, не `eprintln!`. Паника в проде запрещена.
- Все топики — константы в `parvane-types::topics`, не строковые литералы в шардах.
- Чистая доменная логика (CRDT) вынесена в отдельные модули без async/IO и
  покрыта unit-тестами; шард лишь связывает её с NATS и SQLite.

---

## Известные ограничения

- Федерация (`fed.*`, leaf nodes) не реализована.
- Пароли хешируются упрощённо; JWT на симметричном HS256.
- `smarthome` и десктоп-клиент отсутствуют.
- Read receipts мессенджера сохраняются, но пока не отдаются в `msg.sync.response`.
- ACL в `infra/nats/server.conf` есть, но шарды по умолчанию запускаются на NATS
  без авторизации (`nats-server` без `-c`).
