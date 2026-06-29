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

## 3b — врезка отправки в tdesktop (msg.chat.send) ✅ СДЕЛАНО

`parvane_client.{h,cpp}` теперь держит персистентную сессию шины
(`Transport`+`MessengerClient`) после логина, реестр пиров (`address↔id`,
FNV-1a 48-бит — единый `IdForAddress`, общий с синтезом self в intro) и зеркалит
исходящие.

Врезки:
- `ApiWrap::sendMessage` (`apiwrap.cpp`, после проверок отправки/saveRecentSentHashtags):
  `Parvane::MirrorOutgoing(peer.get(), textWithTags.text)` → резолв адреса пира из
  реестра по `peerToUser(id).bare` → `MessengerClient::sendText` на воркер-потоке.
- `intro_parvane.cpp onIssued`: `SetSelf(user,token)` + `crl::async(StartSession)`.
- `main_session.cpp` (конец ctor): `Parvane::AfterSessionReady(this)` — точка
  post-session хуков (сейчас debug-autosend `PARVANE_AUTOSEND=peer@server:текст`).

Проверка e2e: `desktop/verify_phase3b.sh` — headless-форк (autologin+autosend) →
лог `<workdir>/log.txt` показывает login OK · сессия поднята · отправлено · autosend ·
delivered (ack); подписчик `msg.chat.send` ловит ПОЛНЫЙ конверт с
`content:{kind:text,text}`, `to`, UUID v7 id, JWT. **6/6 OK.**
Регресс `scripts/run_all_tests.sh` зелёный (cargo · e2e · transport 10/10 ·
messenger 21/21) — предыдущие уровни не сломаны.

ВАЖНО про логи: tdesktop пишет `LOG()` в `<workdir>/log.txt`, НЕ в stdout —
проверять там. ВАЖНО про бэкенд: для прогона нужны живые identity+messenger
(иначе `No responders available`); `run_all_tests.sh` поднимает свои на temp-БД.

## 3c — приём входящих ✅ СДЕЛАНО

`parvane_client`: `PumpReceive()` (воркер: `MessengerClient::sync(self, token,
zeroCursor, since=0)` → полный список) + `injectOnMain()` на main-потоке:
- дедуп по UUID (`g_uuidToMsgId`), пропуск своих (`from==self`, есть локальное
  эхо) и томбстоунов (`deleted`);
- `ensurePeerUser()` синтезирует/загружает отправителя как `MTPUser`
  (first_name=адрес) через `processUser` — снимает `not loaded user`;
- `buildIncoming()` строит входящий `MTPMessage` (out=false, from/peer =
  отправитель; раскладка полей сверена с `GenerateForwardedItem`);
- синтетический `MsgId` из возрастающего счётчика (серверный диапазон),
  `Data::Session::addNewMessage(id, msg, {}, NewMessageType::Unread)`.

Триггеры: `onDelivered` («что-то изменилось» → pump) и первичный pump в
`AfterSessionReady` (офлайн-бэклог). `g_sessionWeak` — `base::weak_ptr` на
`Main::Session`, инъекция строго на main.

Проверка e2e: `desktop/verify_phase3c.sh` — alice (autologin), ВНЕШНЯЯ публикация
`msg.chat.send` bob→alice (полный конверт, UUID v7, JWT bob) → лог alice:
«получено msg … от bob@local: <text>» + «инъецировано 1 входящих», без падений.
**4/4 OK.** Регресс `run_all_tests.sh` зелёный (cargo · e2e 10/10 · transport ·
messenger 21/21).

## 3d — sync при старте + список диалогов ✅ СДЕЛАНО

- **Стартовый sync**: первичный `PumpReceive` в `AfterSessionReady` подтягивает
  офлайн-бэклог (сообщения, чей `delivered`-бродкаст ушёл в никуда, пока клиент
  был офлайн — NATS fire-and-forget).
- **Периодический sync**: `base::Timer` на main, `callEach(3000мс)` → `PumpReceive`.
  Ловит пропущенные delivered и просто новые сообщения без отдельного триггера.
- **Список диалогов**: после `addNewMessage` у синтезированной истории папка
  «неизвестна» → `shouldBeInChatList()`=false → диалога нет в списке. Фикс:
  `history->clearFolder()` (= `setFolderPointer(nullptr)`, основная папка) при
  `!folderKnown()` → `updateChatListSortPosition` регистрирует диалог
  (`inChatList=1`).

Проверка e2e: `desktop/verify_phase3d.sh` — bob→alice публикуется, ПОКА alice
ОФЛАЙН; после старта alice сообщение всё равно получено стартовым sync, диалог
виден (`в списке=1`), таймер запущен, без падений. **4/4 OK.** Регресс зелёный
(cargo · e2e 10/10 · transport · messenger 21/21).

Известные ограничения (хвост на потом): счётчик непрочитанного `unreadCount`=0
(нужен inbox-read-till); дедуп по UUID — только в памяти (рестарт → повторная
инъекция с новыми MsgId; нужен дисковый курсор/маппинг); ресинк полный каждые
3с (since=0) — для прод нужен инкрементальный двойной курсор. Это не входило в
вертикальный срез «текст 1-на-1 виден и приходит», который закрыт.

## Два экземпляра одновременно ✅ ПРОВЕРЕНО

`desktop/verify_two_instances.sh` — поднимает ДВА реальных headless-форка
одновременно (alice и bob, каждый в своём `-workdir`, оба на одном NATS), без
внешнего `nats pub`: каждый форк сам шлёт другому через штатный путь
`ApiWrap::sendMessage` → `MirrorOutgoing` → `msg.chat.send`. Проверяет полный
двусторонний обмен. **7/7 OK**: alice→bob отправлено, bob→alice отправлено,
bob получил от alice, alice получила от bob, у обоих диалог собеседника в
списке=1, без фатальных ошибок. (В логах также видны исторические сообщения
прошлых прогонов — следствие полного ресинка `since=0`, известное ограничение.)

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
