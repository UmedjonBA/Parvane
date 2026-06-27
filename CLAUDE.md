# Parvane — CLAUDE.md

Parvane — федеративная self-hosted платформа. На данном этапе реализуется
только мессенджер. Назван в честь Парванэ — мотылька-вестника из персидской
мифологии.

## Правила работы с git

- **НИКОГДА не подписывай Claude/Opus/Anthropic соавтором.** Не добавляй
  `Co-Authored-By: Claude ...` в сообщения коммитов и тело PR. Коммиты — только
  от автора-человека.

## Архитектура

Два слоя:

1. **Кан-шина** — Core NATS (fire-and-forget, без персистентности, без JetStream)
2. **Шарды** — независимые Rust-сервисы, каждый со своей SQLite и своей логикой

Персистентность — ответственность шарда, не шины.

## Окружение

Предполагай что Rust/Cargo могут быть не установлены. Проверяй через
`which cargo` и устанавливай через
`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y`
если отсутствует. Аналогично для nats-server и nats CLI.

После установки Rust выполни `source $HOME/.cargo/env` перед любым вызовом cargo.

## Стек

- **Язык**: Rust edition 2021
- **Async runtime**: Tokio
- **Шина**: Core NATS через крейт `async-nats`
- **БД**: SQLite через `sqlx` (feature = "sqlite", "runtime-tokio")
- **Миграции**: `sqlx migrate`
- **Сериализация**: `serde` + `serde_json`
- **JWT**: `jsonwebtoken`
- **Логирование**: `tracing` + `tracing-subscriber`
- **Конфиг**: переменные окружения через `dotenvy`
- **Ошибки**: `thiserror` для библиотечных крейтов, `anyhow` для бинарников

## Структура

```
parvane/
├── CLAUDE.md
├── Cargo.toml               ← workspace
├── shared/
│   └── parvane-types/       ← общие типы событий
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs
└── shards/
    ├── identity/            ← keypair, выдача и верификация JWT
    │   ├── Cargo.toml
    │   ├── migrations/
    │   └── src/
    │       └── main.rs
    └── messenger/           ← приём сообщений, офлайн-очередь, sync
        ├── Cargo.toml
        ├── migrations/
        └── src/
            └── main.rs
```

## Топики NATS

Соглашение: `{domain}.{resource}.{action}`

```
identity.token.issue        ← клиент запрашивает JWT
identity.token.verify       ← шард проверяет JWT у identity

msg.chat.send               ← клиент отправляет сообщение (content: MessageContent)
msg.chat.delivered          ← messenger подтверждает доставку
msg.chat.read               ← клиент отмечает прочитанным
msg.sync.request            ← клиент запрашивает пропущенное после офлайна
msg.sync.response           ← messenger отвечает батчем пропущенных

call.signal                 ← клиент шлёт WebRTC-сигнал (invite/answer/ice/hangup)
call.user.<id>              ← call-шард релеит сигнал в инбокс получателя
call.history.request/response ← история звонков
```

`msg.chat.send` несёт `content: MessageContent` — текст или медиа (voice,
video_note, photo, video, file). Медиа-блоб грузится в шард `cloud`, сообщение
несёт только `file_id` + метаданные. Звонки: шард `call` релеит сигналинг между
двумя пирами (сам медиа-поток — P2P WebRTC, мимо шины).

## Структура события

Каждое событие на шине — JSON:

```json
{
  "id": "uuid-v7",
  "from": "alice@yourserver.com",
  "ts": 1718000000,
  "token": "JWT",
  "payload": { }
}
```

Тип `ParvaneEvent<T>` определён в `parvane-types`.
Конкретные payload-типы (`SendPayload`, `SyncRequestPayload` и т.д.) тоже там.

## Авторизация

Каждое событие несёт JWT в поле `token`.
Messenger верифицирует токен отправляя запрос на `identity.token.verify`.
Identity отвечает на том же топике с результатом верификации.

Identity шард при старте генерирует keypair (Ed25519), хранит в SQLite.
JWT подписывается этим ключом, expiry = 24h.

## Офлайн-модель

Messenger хранит все сообщения в SQLite.
При подключении клиент публикует `msg.sync.request` с полем `last_seen_id`.
Messenger читает из БД сообщения после этого ID и отвечает через `msg.sync.response`.

## Конфиг (переменные окружения)

```
PARVANE_NATS_URL=nats://localhost:4222
PARVANE_DB_PATH=./parvane.db
PARVANE_LOG_LEVEL=debug
```

Каждый шард читает из `.env` файла в своей директории.

## Запуск

```bash
# 1. Запустить NATS
nats-server

# 2. Запустить identity шард
cd shards/identity && cargo run

# 3. Запустить messenger шард
cd shards/messenger && cargo run

# 4. Тестировать через nats CLI

# Получить JWT
nats req identity.token.issue '{"user":"alice@local","password":"test"}'

# Отправить сообщение
nats pub msg.chat.send '{"id":"1","from":"alice@local","ts":1718000000,"token":"<JWT>","payload":{"to":"bob@local","text":"привет"}}'

# Подписаться и смотреть все события
nats sub "msg.>"

# Запросить пропущенные сообщения
nats req msg.sync.request '{"token":"<JWT>","payload":{"last_seen_id":"0"}}'
```

## Соглашения по коду

- Шард стартует в порядке: tracing → NATS → SQLite → миграции → подписки
- Ошибки через `tracing::error!`, паника запрещена в продакшн коде
- Миграции в `shards/{name}/migrations/`
- Все топики — константы в `parvane-types`, не строки в коде шарда

## Порядок реализации

1. Workspace `Cargo.toml`
2. `parvane-types` — `ParvaneEvent<T>` и все payload типы и константы топиков
3. `identity` шард — keypair, issue JWT, verify JWT
4. `messenger` шард — send, delivered, sync

## Когда переключаться на Opus

- Проектирование федеративного протокола
- CRDT логика для notes/calendar
- Сложные баги после 2+ неудачных попыток Sonnet
- Модель прав для smarthome

## Заморожено

- **Шард `smarthome` НЕ разрабатывать** до явного указания пользователя.
  Не создавать пакет, типы, топики или код для него, пока пользователь не
  попросит напрямую.
