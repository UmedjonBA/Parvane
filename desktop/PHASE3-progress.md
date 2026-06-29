# Фаза 3 — ядро мессенджера (журнал прогресса)

Живой статус среза «текстовая 1-на-1 переписка поверх шарда messenger».
Обновляется по ходу работы. Что зелёное — проверено тестами/логами; что нет —
помечено TODO.

## Контракт messenger (выяснено чтением шарда — НЕ менять бэкенд)

- `msg.chat.send` ← ПОЛНЫЙ `ParvaneEvent<SendPayload>` (id/from/ts/token/payload).
  Шард сохраняет и публикует `msg.chat.delivered { message_id }` — это **ack
  отправителю**, тела сообщения там НЕТ, адресата тоже нет (широковещательно).
- **Приём — PULL, не push.** Получатель узнаёт о новых сообщениях только через
  `msg.sync.request` (request/reply, полный конверт) → `msg.sync.response
  { messages: [StoredMessage] }`. Real-time достигается так: подписка на
  `msg.chat.delivered` = «что-то изменилось, синкнись» + периодический sync.
- **Двойной курсор sync**: `id > last_seen_id OR updated_at > since_updated`.
  ВАЖНО: при `since_updated=0` второе условие истинно для всех (updated_at>0) →
  возвращается ВСЁ (полный ресинк; клиент дедупит по id). Инкрементально —
  только продвинув ОБА курсора.
- **id сообщений обязан быть UUID v7** (time-ordered): курсор `id > last_seen_id`
  — строковое сравнение, рассчитан на лексикографический=временной порядок v7.
  v4 ломает инкрементальный sync. `MessengerClient` генерит v7.
- Мутации (Tier 1 Batch A, шард уже умеет): `msg.chat.edit {message_id,text}`
  (только автор → `edited=true`), `msg.chat.delete {message_id}` (tombstone →
  `deleted=true`), `msg.chat.read {message_id}` (получатель → `read=true`, ✓✓).

## 3a — messenger-слой в parvane-core ✅ СДЕЛАНО

Файлы: `desktop/parvane-core/include/parvane/messenger.h` (пейлоады +
(де)сериализация, помощники contentText/contentKind), `messenger_client.h` +
`src/messenger_client.cpp` (`MessengerClient` поверх `Transport`):
- `sendText(from,to,text,token,reply_to?) → id` (публикует конверт на msg.chat.send)
- `sync(from,token,last_seen_id,since_updated?) → vector<StoredMessage>`
- `editText / deleteMessage / markRead`
- `onDelivered(handler)` — подписка на msg.chat.delivered (триггер ресинка)
- UUID v7 генератор внутри (RFC 9562).

Тесты: `desktop/parvane-core/tests/messenger_tests.cpp` — **21/21**, входят в
`scripts/run_all_tests.sh` (уровень 4). Покрыто: helpers, StoredMessage::fromJson,
устойчивость к конверту/голому payload, send→sync (поля), onDelivered, двойной
курсор (полный ресинк vs инкремент), reply_to, edit→sync, read→sync.

Прогон: `bash scripts/run_all_tests.sh` → «ВСЕ УРОВНИ ТЕСТОВ ПРОШЛИ»
(cargo · e2e · transport 10/10 · messenger 21/21).

## 3b — врезка отправки в tdesktop (msg.chat.send) ⏳ TODO

Точка перехвата: `ApiWrap::sendMessage` (`Telegram/SourceFiles/apiwrap.cpp:4199`).
Строит локальное эхо (`generateLocal=true`) и шлёт `MTPmessages_SendMessage`.
План: после локального эха публиковать `msg.chat.send` через parvane-core
(адрес получателя = из peer, текущий self = из логина). JWT — `Parvane::Token()`.
Контроль: `nats sub msg.chat.send` ловит событие; эхо видно в UI.

## 3c — приём входящих ⏳ TODO

Подписка на delivered → sync → синтез `MTPmessage` → инъекция в History/Data::Session.
Предпосылка (из Фазы 2): self/пиров надо корректно грузить в Data::Session
(сейчас варнинг `userIsContactChanged for a not loaded user`).

## 3d — sync при старте + список диалогов ⏳ TODO

`msg.sync.request` при логине, построение диалогов из истории, курсоры на диске.

## Как проверять вручную

```bash
# поднять бэкенд
nats-server &                                   # уже может быть запущен (4222)
PARVANE_DB_PATH=/tmp/id.db  ./target/debug/identity  &
PARVANE_DB_PATH=/tmp/msg.db ./target/debug/messenger &

# весь регресс
bash scripts/run_all_tests.sh

# headless-логин форка (Фаза 2)
cd desktop/build-probe/bin
QT_QPA_PLATFORM=offscreen PARVANE_AUTOLOGIN='alice@local:test' \
  ./Telegram -workdir /tmp/parvane-fork-test 2>&1 | grep Parvane
```
