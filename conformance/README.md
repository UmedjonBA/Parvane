# Conformance — правила, обязательные для ВСЕХ клиентов

Клиентов три (web, desktop, android), и каждый реализует протокол Parvane
самостоятельно. Из-за этого починка уезжает в один клиент и не доезжает до
остальных. Реальный случай: коммит `23ce150d` починил продвижение курсора синка
в вебе (сентябрь 2026), а десктоп остался с той же дырой и терял сообщения ещё
несколько недель, пока пользователь не сообщил «чат отстаёт и не догоняет».

Здесь лежат правила, которые обязан соблюдать любой клиент, с идентификаторами.
Правило считается закрытым, только когда на него есть тест В КАЖДОМ клиенте.
`sync-rules.json` — машиночитаемая версия для тестов.

**T110 (7 окт 2026): сервер и web без протокола v1.** Пункты правил о v1-пути —
курсор синка v1 (SYNC-1/2), повтор `msg.chat.read` (READ-1), подпись
v1-отправки и ack (SEND-1), v1-топики typing/presence (EPHEMERAL-1), нотис v1
группы (GROUP-1), легаси-копии (LEGACY-1), понижение до v1 (TYPING-1), перевод
групп v1 (GROUP-4), v1-блоб настроек (STATE-2), виртуальное соединение (E6-1), ключи
устройств v1 и TOFU по ним (KEY-1, E2E-1 — автора проверяет движок v2), материал v1 и
перенос владения в линковке (LINK-1) —
для web закрыты удалением кода: сторож `conformance.test.ts` проверяет, что
v1-код в web не вернулся. Для desktop и android эти пункты действуют до их T110
(десктоп и Android остаются совместимы по v2). Поле `clients.web` в
`sync-rules.json` у таких правил описывает состояние после T110.

**spec 029 (18 окт 2026): desktop без протокола v1.** Из ядра `parvane-core` и
клиента `parvane_client.cpp` удалены Olm/Megolm (`e2e.cpp`), `messenger_client`/
`group_client`/`call_client`, `v2_legacy`, прямой NATS (`transport.cpp`), курсоры
синка и очередь починки; транспорт — только мост v2 (`BridgeTransport` без
внутреннего v1-транспорта, `publish` пустой), запись LegacyV1 пропускается,
сценарий `verify_protocol_v2_v1off.sh` удалён. Те же пункты правил, что у web
после T110 (SYNC-1/2, READ-1, E2E-1, KEY-1, SEND-1, EPHEMERAL-1, GROUP-1, LEGACY-1,
GROUP-4, STATE-2, E6-1, LINK-1), для desktop закрыты удалением кода: сторож
проверяет, что v1-кода в desktop нет, а остальные desktop-пункты смотрят в
v2-код (`v2_session*.cpp`, `v2_bridge.cpp`, `v2_content.cpp`). Поле
`clients.desktop` описывает состояние после spec 029. Android — до своего T110
(его `jni` использует удалённые модули ядра и до перехода не собирается).

## SYNC-1. Дисковый курсор двигается только по применённому

Курсор, переживающий рестарт, продвигается ТОЛЬКО за сообщения, которые
успешно расшифрованы и вставлены в UI. Причина: ратчет Olm одноразовый, и
сообщение, пропущенное за курсором, после рестарта не вернётся дельтой —
оно потеряно навсегда.

- В памяти курсор двигать можно всегда (иначе один и тот же кусок тянется по кругу).
- Пока E2E не поднялся, дисковый курсор не двигать вовсе.
- Умышленный отказ (подмена отправителя, чужой SKDM) курсор НЕ придерживает:
  иначе одно подложное сообщение заморозит синк жертвы навсегда.

Реализации: web `api/parvane/sync.ts` (`persistCursor`, флаг `sawUndecryptable`);
desktop `parvane/parvane_client.cpp` (`prepareIncoming` → `NotePendingAndMayAdvance`);
android `jni/parvane_jni.cpp` (`enum class Deliver`, `g_diskCursorId` → `cursors.json`
только после `Applied`, придержанное — `pending.json`; маркеры «курсор придержан»,
«курсор: … применён», 27 сен 2026). Тест android — сценарий на эмуляторе
`android/tgx_conformance_flow.sh`, шаг 1 (см. «устройство отсутствовало» ниже).

## SYNC-2. Непрочитанное не держит курсор вечно

Придерживать дисковый курсор из-за нерасшифрованного можно ограниченное число
попыток. Копии под наш `device_id` могло не создаться вовсе (каталог устройств
у отправителя протух), и тогда курсор застыл бы навсегда, а клиент
пересинхронизировал бы всю историю при каждом старте.

- После N попыток (desktop: `kRepairAttempts` = 3) сообщение пропускается с
  записью в лог. История в этом случае восстанавливается авто-линковкой.

Реализации: desktop `NotePendingAndMayAdvance` (`tdata/parvane-pending.txt`);
web `mayAdvanceDiskCursor` + `localState.loadRepairAttempts` (9 сен 2026);
android `jni/parvane_jni.cpp` (`kRepairAttempts` = 3, `pending.json`, маркер
«курсор отпущен после 3 попыток (SYNC-2)»; на чистом проходе сценарий
`android/tgx_conformance_flow.sh` проверяет, что ничего не придержано).

## PROFILE-1. Профиль собеседника перечитывается по TTL

Имя и аватар меняются на другом устройстве. Кэш профиля обязан иметь срок
годности; резолв «один раз за сессию» запрещён. Пуша об изменении профиля в
протоколе нет: у identity нет прав публикации в инбокс пользователя
(`IDENTITY_NATS_PUBLISH` = только `_INBOX.>`), поэтому TTL — единственный
механизм.

Реализации: web `resolveDisplayNames` на каждом проходе синка;
desktop `g_resolvedAt` + `kProfileTtlMs` (10 мин), включая собственный профиль;
android `libtd/.../Client.kt` (`resolvedAt`, `profileTtlMs` 10 мин, тик раз в
60 с; для e2e TTL переопределяется файлом `/data/local/tmp/parvane-profile-ttl`
в мс). Тест android — `android/tgx_conformance_flow.sh`, шаг 3 (bio сменён на
desktop → профиль перечитан без перезапуска X).

## READ-1. Прочитанное журналируется локально и подтверждается

`msg.chat.read` уходит без ответа. Клиент обязан:

- записать прочтение локально ДО публикации (переживает перезагрузку);
- считать сообщение прочитанным по объединению локального журнала и серверного флага;
- повторять публикацию, пока сервер не вернёт `read=true`.

Реализации: web `localState.loadReadUuids/saveReadUuids`, `retryUnconfirmedReads`;
desktop `g_reportedRead` + `tdata/parvane-read.txt`, `RetryUnconfirmedReads` (9 сен 2026);
android `jni/parvane_jni.cpp` (`read.json` + запись в журнал ДО `msg.chat.read` —
«прочитано локально»; `g_unconfirmedRead` повторяется в `pumpLoop`, пока сервер
не вернёт `read=true` — «read подтверждён»). Тест android —
`android/tgx_conformance_flow.sh`, шаг 2 (после рестарта X бейдж не возвращается).

## FAIL-1. Ожидание без ответа запрещено

Любой путь, ждущий сеть, обязан иметь конец: таймаут, ветку ошибки или
локальное завершение. Нативный UI форков ждёт MTProto, которого нет.

- desktop: ОБОБЩЕНО 9 сен 2026 — `MTP::Instance::Private::sendRequest` любой
  запрос отдаёт в `fail` локальной ошибкой `PARVANE_NO_MTPROTO` (с задержкой
  300 мс; колбэки — в штатной карте запросов, чтобы `cancel()` разрушенного
  `MTP::Sender` их снимал, иначе отложенный fail бьёт по мёртвому объекту —
  10 сен 2026). Точечные локальные завершения (`ChatFilters::load`, выход,
  отказ авторизации) остаются. Тест отказа авторизации без падения —
  `desktop/verify_auth_reject.sh`. Обрыв соединения с gateway: транспорт
  сам переподключается (auth + подписки), тест —
  `desktop/verify_gateway_reconnect.sh`.
- web: `useModuleLoader` ловит отказ импорта, `moduleLoader` не кэширует
  отвергнутый промис, устаревший чанк лечится одноразовой перезагрузкой.
- android: `jni/parvane_jni.cpp` `pumpLoop` — ошибка синка «отказ авторизации» /
  «просроченный JWT» / «устройство отозвано» → событие `session failed`
  (`reason=auth`) → `Client.kt` `sessionExpired()`: стор очищен, `session.json`
  снят, ключи `e2e-*` и `journal.jsonl` сохранены, X переводится в
  `LoggingOut → WaitPhoneNumber` (не `Closed` — тот стирает данные). Обрыв
  gateway: транспорт ядра переподключается сам, обработчик в `nativeInit`
  пишет «gateway переподключён». Тест — `android/tgx_conformance_flow.sh`,
  шаги 4 (отзыв устройства с alice-desktop → экран входа, данные на месте)
  и 5 (`gateway_restart` → реконнект → следующее сообщение доставлено).

## MAP-1. Фрагменты карты — только через шард preview

Любой клиент, показывающий карту (статичная точка, venue, live), запрашивает
тайлы исключительно через `preview.map.tile` (Web Mercator z/x/y, PNG в
base64). Прямых сетевых обращений клиента к картографическим сервисам
(`tile.openstreetmap.org`, Google/Yandex-тайлы и т. п.) быть не должно — иначе
IP пользователя и просматриваемая область утекают третьей стороне. Клик
«открыть карту» во внешнем браузере — явное действие пользователя, правилом не
покрывается. Центр и зум статичной карты одинаковы на всех клиентах
(`defaultZoom` в `sync-rules.json`, размер пузыря — свой у каждого клиента).
Запрошенный зум клиент обрезает до `maxZoom` (15): шард `preview` после ревью
безопасности (P-23) не отдаёт тайлы подробнее — серверу и OSM уходит
окрестность, а не точка; клиент, просящий z16, остаётся без карты.

Реализации: web `api/parvane/media.ts` (`fetchTile`/`renderStaticMap`);
desktop `parvane-core/src/map_tiles.cpp` (геометрия, клиент тайлов, LRU) +
`parvane/parvane_map.cpp` (склейка → нативный `Data::CloudImage` через
`Session::location()`, 15 сен 2026); android `libtd/.../Client.kt`
(`mapThumbnail`: `GetMapThumbnailFile` X → `ParvaneCore.mapTile` →
`jni nativeMapTile` → `preview.map.tile`, склейка в файл) + `MapGeometry.kt`
(порт `computeGeometry` десктопа, 27 сен 2026). Тесты: web `conformance.test.ts`
(MAP-1, включая grep хостов в android), desktop `desktop/verify_location_map.sh`
(grep хостов + runtime-маркер «через preview»), android — JVM
`FoldersMapTest.mapGeometryMatchesDesktop` и сценарий
`android/tgx_folders_preview_flow.sh`, шаг 3 (маркер «тайл 15/x/y через preview»).

## PACK-1. Архив пака — под набор получателей

Архив стикер- или эмодзи-пака (PVPK1) лежит в `cloud` шифртекстом, и доступ к
нему выдаётся только получателям, перечисленным при загрузке
(`file.upload.complete.recipients`); добавить получателя позже нельзя. Клиент
может переиспользовать уже загруженный архив только для сообщения, все
получатели которого входят в тот набор; иначе архив загружается заново под
новый набор. Иначе второй собеседник получает ссылку на пак, который не может
скачать (эмодзи не отрисуется, стикер-пак не установится).

Реализации: web `api/parvane/messages.ts` (`shouldReusePackRef`,
`buildPackRefForSet`, 15 сен 2026); desktop `parvane_client.cpp`
(`FindUploadedPackRef`/`RememberUploadedPackRef` — ссылка помнится вместе с
набором получателей, переиспользуется только для его подмножества, 16 сен
2026); android `jni/parvane_jni.cpp` (`nativePackRefFor`: `packrefs.json`,
ссылка помнится вместе с набором получателей, повтор только для подмножества,
не больше 8 вариантов на пак) + `libtd/.../Stickers.kt` (`packRefForSend`,
`emojiPacksFor`, 27 сен 2026). Тесты: web `conformance.test.ts` (PACK-1) и
кросс-сценарий `scripts/e2e_web_cross_emoji.mjs` (второй получатель), desktop
`verify_conformance_packs.sh` (два архива в cloud на двух получателей), android
— JVM `StickersTest.sendResolvesInputFileIdAndAttachesPackRefByRecipients`,
`PackIndexTest` и сценарий `android/tgx_stickers_flow.sh`.

## PACK-2. Один набор от разных отправителей — один набор

`PackRef.content_hash` (поле 7, 17 окт 2026) — SHA-256 по файлам набора,
отсортированным по имени (сравнение байтов UTF-8): для каждого файла подряд
`имя (UTF-8) ‖ 0x00 ‖ u32LE размер ‖ SHA-256(байты файла)`. Имена и файлы —
после той же санитизации, что при распаковке PVPK1 (basename, знакомые
расширения). Отправитель кладёт отпечаток своего архива. Получатель объединяет
ссылки с одинаковым отпечатком в один набор (иначе наборы с одним именем от
разных отправителей различаются по отправителю, PACK-1/EMOJI-1), а скачанный
архив обязан дать заявленный отпечаток — несовпадение: архив отвергается, набор
не устанавливается. Ссылка без отпечатка (старый клиент) ведёт себя как раньше.

Реализации: web `api/parvane/stickerPacks.ts` (`packContentHash`,
`registerReceivedPackRef`), `messages.ts` (`buildPackRefForSet`), `provider.ts`
(`resolveCustomPack` — сверка). Desktop: ядро `parvane-core/src/pack_archive.cpp`
(`contentHash`, `archiveContentHashB64`, `archiveMatchesContentHash`), `src/v2_content.cpp`
(`packToV2`/`packFromV2` переносят `content_hash`); tdesktop `parvane_client.cpp` — отпечаток в
ссылку при отправке (`AttachPackContentHash`, стикер и `emoji_packs`), установка набора по стикеру
(`InstallStickerPackFromDocument`: набор с тем же отпечатком уже стоит — он и есть,
`FindInstalledPackByHash`; другой набор с тем же именем — отдельный каталог, `DistinctPackName`;
архив с чужим отпечатком отвергается), сверка эмодзи-пака в `MaterializeEmojiPacks` (эмодзи-паки
по-прежнему различаются именем из ссылки — от него docId, EMOJI-1). Тесты: `tests/pack_tests.cpp`,
`tests/webcompat_tests.cpp` — общий вектор `proto/parvane/vectors/clients/pack-hash.json` (его же
проверяет web `clientVectors.test.ts`), `tests/v2_tests.cpp`. Android — ОТКРЫТО (то же).

## CALL-2. Название группы во входящем групповом звонке

`GroupRing.group` (поле 3) — ссылка на группу, в чате которой начат звонок, и
`GroupRing.title` (поле 4, 17 окт 2026, ≤ 255 байт) — её название. Получатель,
знающий группу, показывает своё название из её журнала (приглашению не верит);
не знающий (новое устройство, не участник) — название из приглашения, без
управляющих и bidi-символов. Без ссылки (старый клиент) — подбор группы по
составу участников, затем название из приглашения.

Реализации: web `v2/callMap.ts`, `groupcall.ts` (`inviteGroupTitle`), `calls.ts`;
тесты `v2Call.test.ts`, `groupcall.title.test.ts`. Desktop (spec 029): ядро
`v2_content.cpp` (`callSignalToV2`/`callSignalFromV2` — `group` и `title`,
`cleanGroupTitle`), `call.h` (`groupInviteSignal`), `group_call_manager.cpp`;
tdesktop `parvane_client.cpp` (`StartGroupCall`, `ShowIncomingGroupCall` — известная
группа своим названием, неизвестная — из приглашения); тесты
`tests/call_manager_tests.cpp` («CALL-2: во входящем — группа и её название»),
`tests/webcompat_tests.cpp` (очистка названия как web). Android — ОТКРЫТО.

## FED-1. Федерация серверов (spec 028)

1. Любой запрос, касающийся пользователя, группы, контейнера или блоба другого сервера, клиент шлёт СВОЕМУ
   серверу с `Request.dest_domain` = домен объекта; к чужому серверу напрямую не подключается. Адресат запросов,
   собранных движком, — `parvane_protocol::routing::dest_of` (получатель письма или сигнала, группа, контейнер).
2. Домен блоба: `Media.blob_domain` / `PackRef.blob_domain` (пусто — домен отправителя; при пересылке вложения
   с другого сервера — исходный), `CloudBlobRef.uploader`, `SetInfo.avatar_domain` (пусто — домен группы),
   аватар пользователя — домен адреса.
3. Жетоны для письма незнакомцу с другого сервера — от сервера адресата (свой запас на каждый домен), ключ
   сервера — из `server.describe` с адресатом, подпись описателя проверяет движок.
4. Звонок принимается, если цель сигнала — домен звонящего; ключ контейнера облака — от сервера раздающего;
   группа и контейнер хранят свой домен.
   «Печатает» собеседнику с другого сервера — `dest_domain` его домена (движок: `OutRequest.dest`), в группе —
   домен группы; канал подписки — у своего сервера.
5. Коды `FEDERATION_UNAVAILABLE`, `DOMAIN_BLOCKED`, `DOMAIN_REFUSED`, `DOMAIN_UNREACHABLE`,
   `SERVER_KEY_CHANGED` показываются своими строками (EN+RU).

Реализации: web — `v2/address.ts`, `v2/controller.ts`, `v2/cloud.ts`, `v2/bridge.ts`, `provider.ts`, тесты
`v2/address.test.ts`, сценарий `scripts/run_web_federation_e2e.sh`; сервер — `cargo test -p parvane-integration
--test v2_federation_live` (два стека). Desktop — сделано (spec 029): `OutRequest.dest`,
`Connection::request`/`Control::call` с `dest`, `groupDomainLocked`, `requestForeignTokensLocked`, `Media.blob_domain`;
tdesktop `NoteFederationFailure` — причины строками EN+RU; сценарий
`desktop/verify_federation.sh` (зелёный 19 окт 2026) (два локальных сервера `a.parvane.test`/`b.parvane.test` с шардом federation на тестовом
транспорте, по клиенту на сервер, личное письмо в обе стороны; `verify_lib.sh` — порты стека `PV_NATS_PORT`/
`PV_GW_WS_PORT`/`PV_GW_TCP_PORT`, соседи `PV_FEDERATION_PEERS`); `tests/v2_tests.cpp` проверяет только перенос
`blob_domain`. Android — ОТКРЫТО: без `dest_domain` он работает в
пределах своего сервера, адрес другого сервера получает прежний `FEDERATION_UNAVAILABLE`.

## EMOJI-1. docId кастом-эмодзи — от имени из ссылки

docId документа кастом-эмодзи = FNV-1a-64 с начальным значением
`1469598103934665603` и множителем `1099511628211` (знаковый int64 десятичной
строкой) от UTF-8 `pvemoji:<N>|<файл>`. Начальное значение — стандартное
FNV-смещение без последней цифры: так исторически считают desktop и android,
это формат провода, веб перешёл на него 15 сен 2026 (прежние веб-docId со
стандартным смещением резолвятся как алиасы). Здесь `N` — ровно `name` из ссылки на пак, пришедшей с сообщением
(`emoji_packs[].name`), а не нормализованное имя каталога. Отправитель кладёт в `name` ровно ту строку, от которой считал docId
своих сущностей. Клиент помнит все имена, под которыми приходил набор, и
резолвит документ по любому из них; установленный пак хранит исходное имя,
чтобы docId не менялись после перезапуска.

Реализации: web `api/parvane/stickerPacks.ts` (`buildEmojiDocId`, `rawName`,
алиасы набора) + `provider.ts` (`buildCustomSet`, `fetchCustomEmoji`), 15 сен
2026; desktop `parvane_client.cpp`: при материализации сырое имя пака пишется
в `.pvname` рядом с каталогом, `LoadLocalCustomEmoji` читает его через
`ReadRawPackName` (16 сен 2026); android `libtd/.../EmojiDocId.kt`
(`emojiDocId`: та же FNV-1a-64 от `pvemoji:<rawName>|<file>`, константы
`OFFSET_BASIS`/`PRIME`) + `PackIndex.kt` (`emojiByDocId` по сырому имени из
`emoji_packs[].name`, 27 сен 2026). Тесты: web `conformance.test.ts` (EMOJI-1) и
`scripts/e2e_web_cross_emoji.mjs`, desktop `verify_conformance_packs.sh`
(рестарт получателя), android — JVM `EmojiDocIdTest`
(`constantsMatchConformance`, `docIdUsesRawNameAndFile`),
`StickersTest.emojiPacksLimitedToFourAndResolvedByDocId` и сценарий
`android/tgx_stickers_flow.sh`, шаг 3 (docId, посчитанный desktop, разрешается в X).

## GROUP-1. Сведения группы применяются по ревизии, изменения — без перезагрузки

Сервер (шард `messenger`) держит у группы ревизию `version`, растущую на каждую
мутацию (имя, фото, описание, права по умолчанию, роль/права участника, состав,
ссылки, заявки). Онлайн-участникам изменение приходит уведомлением в инбокс
`msg.user.<адрес>` — поле `group` в кадре (как `notify`/`read`/`cleared`):
`{group_id, version, change, info?}`; для `info | perms | members | admin`
вложены итоговые сведения `GroupInfo`, для `invites | requests` — только факт
(клиент перечитывает открытый экран), `removed | deleted` — группа снимается
у адресата. Отсутствовавшее устройство догоняет итог обычным `group.list`.

Клиент обязан:

- применять `GroupInfo` (из нотиса или списка) только если его `version` не
  меньше известной; равная — идемпотентно; меньшую игнорировать. Иначе нотис,
  догнавший более свежий список, откатывал бы фото/описание/права;
- применять сведения к уже открытым экранам (профиль, участники, права,
  ссылки, заявки) без перезагрузки; удалённому/забаненному — убрать группу из
  списка чатов;
- неизвестный `change` не считать ошибкой: игнорировать поле и перечитать
  группу; кадр без поля `group` (старые клиенты) — игнорировать целиком.

Права по типу содержимого — отдельное правило GROUP-2 ниже.

Реализации: web `api/parvane/store.ts` (`shouldApplyGroupInfo`, `registerGroup`),
`api/parvane/groups.ts` (`applyNotice`, `refreshMemberships`), `api/parvane/sync.ts`
(поле `group` в `handleInboxFrame`), 22 сен 2026; desktop
`parvane-core/src/messenger_client.cpp` (`onGroupNotice`) +
`parvane/parvane_client.cpp` (`ApplyGroupInfo` с `g_groupVersions`,
`DropGroupLocally`); android `jni/parvane_jni.cpp` (событие `group`) +
`libtd/.../Client.kt` (`onCoreEvent("group")` → `syncGroups`) +
`libtd/.../ParvaneStore.kt` (`ensureGroup` по `version`). Тесты: web
`conformance.test.ts` (GROUP-1) и `scripts/e2e_web_group_info.mjs` (открытый
профиль, устройство отсутствовало); desktop `desktop/verify_conformance_group.sh`
(нотис/список, устаревший нотис, рестарт, нотис применяется ровно один раз);
android — JVM-юнит `libtd/src/test/.../ParvaneStoreGroupTest.kt` и сценарий
на эмуляторе `android/tgx_group_manage_flow.sh` (нотисы perms/members → 
`UpdateChatPermissions`/`UpdateBasicGroupFullInfo` без перезапуска; зелёный
27 сен 2026, AVD с mesa-обходом). Правило закрыто на всех клиентах.

## GROUP-2. Права по типу содержимого соблюдаются на клиенте

Сервер видит только шифртекст группового сообщения и проверяет лишь
`send_messages` (участник без роли и без права не может писать вовсе), а
также отдельные действия (закреп, приглашение, смена информации). Тип
содержимого — медиа, стикеры/GIF, опросы, ссылки в тексте — сервер не знает,
поэтому права по умолчанию по типу содержимого (`send_media`,
`send_stickers_gifs`, `send_polls`, `embed_links`) соблюдают клиенты, и ТОЛЬКО
все три сразу: иначе то, что один клиент не даёт отправить, другой покажет и
позволит отправить в обход (2026-09-26, spec 004).

Клиент обязан:

- в композере и меню вложений участника без роли блокировать запрещённые
  виды по текущим правам по умолчанию (владелец и админы ограничениям не
  подчиняются);
- полученное групповое сообщение запрещённого вида от участника без роли не
  показывать и не считать непрочитанным; факт скрытия писать в журнал;
  сообщения владельца и админов показывать всегда; сообщения с неизвестной
  ролью автора (сведений группы ещё нет) — показывать;
- оценивать при приёме и не пересматривать уже показанное при смене прав
  (единая формула — таблица `contentKinds` в `sync-rules.json`: `send_media`
  → photo/video/file/voice/video_note/audio, `send_stickers_gifs` →
  sticker/gif, `send_polls` → poll, `embed_links` → text с превью или
  URL-сущностью; `send_messages=false` → любой вид; location не фильтруется).

Реализации: web `api/parvane/groups.ts` (`isContentAllowedForMember`) и
`api/parvane/sync.ts` (`isHiddenByGroupPermissions`, live + full sync,
журнал `group-perm-hidden`), композер — `defaultBannedRights` (spec 003);
desktop `parvane-core/include/parvane/group.h` (`isContentAllowedForMember`,
`contentHasLink`) + `parvane/parvane_client.cpp` (`injectOnMain`, маркер
«скрыто правами группы»; композер — нативные `defaultRestrictions` через
`amRestricted`); android `libtd/.../ParvaneStore.kt` (`isContentAllowedForMember`)
+ `Client.kt` (приём), композер — `Chat.permissions`. Тесты: web
`conformance.test.ts` (GROUP-2: таблица кейсов + grep desktop/android);
desktop `desktop/verify_conformance_perms.sh` (файл в обход скрыт,
владелец не фильтруется, композер блокирует) и parvane-core
`parvane_group_client_tests`; android — JVM `ParvaneStorePermsTest` и сценарий
на эмуляторе `android/tgx_group_manage_flow.sh` (файл участника без права
скрыт и в чат не попал, после возврата права показан; зелёный 27 сен 2026).
Правило закрыто на всех клиентах.

## E2E-1. Автор берётся из провода, SKDM — из identity конверта, неподтверждённое не показывается

Автор E2E-сообщения определяется ТОЛЬКО так:

- **1-на-1 (Olm, sealed)** — реальный отправитель внутри шифртекста (`inner.from`),
  и он обязан быть подтверждён: `sender_identity` конверта принадлежит этому
  адресу по каталогу устройств (`verifySender`).
- **Группа (Megolm)** — автор ВСЕГДА wire `from` (его ставит gateway из
  авторизованной сессии). `inner.from` из Megolm-plaintext НЕ используется как
  автор: его контролирует отправитель, иначе любой участник выдаёт себя за
  другого (находка P-02).

Канонический Megolm-plaintext — ГОЛЫЙ `content` (объект `MessageContent`).
Старые клиенты слали обёртку `{from, content}`; приём обязан принимать обе
формы, но `from` из неё игнорировать. Отправка — только голый `content`.

SKDM (раздача ключа группы) принимается ТОЛЬКО если `sender_identity` внутри
SKDM совпадает с identity Olm-конверта, реально расшифровавшего сообщение —
иначе участник затирал бы Megolm-канал другого, назвав его identity (P-02).

Вердикт `unknown` (каталог отправителя недоступен, подтвердить нельзя):
сообщение НЕ показывать и НЕ подтверждать (`ack`) — оставить нерасшифрованным,
sync повторит позже; дисковый курсор при этом не двигать (SYNC-1). Ранее
такое сообщение показывалось без подтверждения — окно для спуфа при
недоступном identity-шарде (P-26).

Реализации: web `api/parvane/sync.ts` (`unwrapMegolmContent`, ветка `unknown` в
`applyStoredUpdateUnserialized`); desktop `parvane-core` `groupSeal` (голый
content) + `parvane_client.cpp` `prepareIncoming`/`injectOnMain`; android
`jni/parvane_jni.cpp` (`deliverStored`). Тесты: web `conformance.test.ts`
(`E2E-1`), desktop `parvane-core/tests/e2e_tests.cpp` (голый content), android
`libtd/src/test`.

## LINK-1. Линковка v2: обязательство, challenge, SAS от пары ключей, без приватного аккаунта

Перенос истории на новое устройство (P-03, P-48) идёт по одному протоколу во
всех клиентах:

1. **Оффер** — новое устройство публикует `identity.link.offer` с
   `commitment = base64(SHA-256(raw eph_pub))` и своим `signing_key`;
   сам `eph_pub` НЕ раскрывается.
2. **Challenge** — старое устройство шлёт `identity.link.challenge`
   `{device_id: <новое>, eph_pub: <свой эфемерный P-256>}`. Сервер фиксирует
   первый challenge и не даёт его заменить.
3. **Раскрытие** — новое устройство видит `challenge` в `identity.link.poll`
   и переотправляет оффер с `eph_pub` и тем же `commitment`; сервер (и старое
   устройство) сверяют `SHA-256(eph_pub) == commitment`.
4. **SAS** — обе стороны показывают 12 цифр (`dddd dddd dddd`, ≈40 бит) от
   `SHA-256("parvane-link-sas-v2" || raw new_pub || raw old_pub)`, первые
   8 байт big-endian по модулю 10^12. Сервер-MITM не может подобрать ключ
   под уже показанный код: ключ нового устройства связан обязательством,
   ключ старого — фиксированным challenge.
5. **Грант** — старое устройство шифрует в ECDH-бокс координаты экспорта и
   `transfer = {old_signing_key, signature}` — подпись Ed25519 над строкой
   `link-transfer:<user>:<old_signing_key>:<new_signing_key>`. Новое устройство
   принимает грант ТОЛЬКО если `grant.eph_pub` равен ключу challenge, с которым
   считался код.
6. **Экспорт** (`linkVersion: 2`) не содержит приватного материала: ни
   `account`, ни `pickleKey`, ни `legacyAccounts`. Передаются decCache,
   входящие Megolm (exported session keys), каталоги и накопленные
   `transfers`. Новое устройство остаётся самостоятельным (свой Olm-аккаунт),
   исходящие прежних устройств messenger отдаёт по `transfers` в
   `msg.sync.request` (подпись проверяется на сервере).

7. **Протокол v2 (spec 007)** — если старое устройство на v2 и держит
   self-signing-ключ, в бокс добавляется `v2 = {file_id, file_key, file_nonce}`:
   координаты второго зашифрованного блоба с материалом гранта движка
   (`linkGrantMaterial`: JSON `{ssk, log, dk, gen, sk, skv}` — self-signing-ключ,
   журнал устройств, ключ доставки с поколением, ключ личного состояния с
   версией; формат один для WASM и C ABI). Материал в бокс не кладётся — бокс
   ограничен 8 КБ. Новое устройство, у аккаунта которого журнал устройств уже
   есть, своего корня НЕ создаёт: публикует оффер (даже если история v1 на нём
   есть), по материалу вызывает `joinWithGrant` — записывает себя в журнал
   устройств (`identity.device.publish_certificate`), ключ доставки заново не
   ставит — и только после этого поднимает v2-сессию и журнал личного
   состояния. До гранта устройство работает по v1. Негодный материал не
   повторяется: устройство снова ждёт линковку. Клиент без v2 поле `v2`
   игнорирует.
8. **История v2-эпохи (spec 007, T138, SC-002)** — сообщения v2 запечатаны под
   устройства, существовавшие в момент отправки: новому устройству сервер их не
   отдаст, а материал гранта несёт только ключи. Поэтому старое устройство
   кладёт в экспорт линковки (тот же блоб, что `decCache`) поле `v2History` —
   массив уже расшифрованных строк v2 в формате хранимого сообщения:
   `{id, from, to, ts, content, reply_to?, edited?, reactions?, pinned?, read?}`
   (личные чаты и группы `v2g:<hex>`; не больше 20 000 самых свежих строк; без
   удалённых, без сообщений с TTL, без нерасшифрованных `encrypted`/
   `group_encrypted`). Новое устройство применяет строки как сообщения v2
   (v1-курсор синка по ним не двигается, v1-подтверждений нет), дубль по `id`
   пропускает, битые строки пропускает. Входящие из истории считаются
   прочитанными; `read` своих исходящих — как знает старое устройство. Строки
   группы v2 применяются только когда группа уже известна устройству (из
   журнала группы после вступления в журнал устройств), до этого ждут. Клиент,
   не знающий поля, его игнорирует. **С T110 (v1 удалён, 8 окт 2026)** в экспорт
   идут ВСЕ расшифрованные строки кэша истории, включая строки эпохи v1 (без
   пометки `origin`): серверной истории v1 больше нет, и новому устройству их
   взять неоткуда — без этого второе устройство аккаунта с перепиской до v2
   получало пустой список чатов (прод, 8 окт 2026). Не переносится только
   `chat_mode` из эпохи v1 (принимается лишь из v2).
9. **Группы v2 новому устройству (spec 007, T142)** — материал гранта несёт
   только ключи устройства. Устройство аккаунта, увидевшее в СВОЁМ журнале
   устройств новое устройство (то же место, где показывается уведомление «новое
   устройство»), вызывает движок `shareGroupsWithOwnDevices([id…])` и отправляет
   полученные запросы: по каждой группе v2, где аккаунт состоит и есть ключи
   текущей эпохи, — `GroupKeyShare` с `envelope_key` (+ `send_private_key`, если
   есть право писать) и по одному `GroupKeyShare` с `megolm_exported` +
   `megolm_owner` на каждую известную входящую сессию Megolm текущей эпохи
   (экспорт с первого известного индекса). Конверты запечатаны только под
   перечисленные свои устройства. Приём (движок): ключ эпохи принимается от
   админа, создавшего эпоху, ЛИБО от устройства своего аккаунта; `megolm_exported`
   — только от устройства своего аккаунта (иначе `FORBIDDEN`), известную сессию
   не заменяет. Группу, которой новое устройство ещё не знает, оно дочитывает
   само по журналу группы (ключи ждут в очереди). Хост ничего из этого не
   разбирает (PROTO-1).

10. **Ключи доступа контактов новому устройству (spec 007, T154)** — материал
    гранта движка несёт поле `pk`: `[{"u": адрес, "k": hex ключа доступа,
    "g": поколение}]` — ключи доступа собеседников старого устройства. Новое
    устройство принимает их при `joinWithGrant` (записи с негодным адресом или
    ключом пропускаются; грант без поля принимается). Без этого привязанное
    устройство писало бы знакомым слепыми жетонами (50 в сутки на аккаунт) и не
    могло бы ни позвонить, ни ответить на звонок: сигнал звонка сервер принимает
    только по ключу доступа адресата. Поле собирает и разбирает движок
    (`host::grant_peer_keys` / `apply_grant_peer_keys`, общие для C ABI и WASM) —
    клиенты его не трогают. Тест: движок `link_grant_carries_peer_delivery_keys`,
    сторож LINK-1 (набор ключей материала `v2Grant.materialKeys`).

Legacy-офферы v1 (без `commitment`, 6-значный код от одного ключа) не
обслуживаются старым устройством. Код сверки не пишется в логи release-сборок.

Кросс-клиентские векторы (`vectors` в `sync-rules.json`): `new = 65×0x00`,
`old = 0x04 || 64×0x01` → `commitment(new) = mM5C3u9R1AJp1UL1MUvvLHRo1AGtXYUWi/q0wBCPdfc=`,
`SAS = 5659 7031 8371`.

Реализации: web `api/parvane/linking.ts` (`linkCommitment`, `sasCodeV2`) +
`provider.ts` (`startHistoryLinkOffer`, `describeLinkOffer`, `parvaneGrantLink`) +
`e2e.ts` (`exportLinkStateJson`, `signLinkTransfer`, `importLinkedHistory`) +
`v2/linkHistory.ts` (`collectV2History`, `parseV2History`);
desktop `parvane-core` `linking.cpp`/`e2e.cpp` + `parvane_client.cpp`
(`StartHistoryLinkOffer`, `PollLinkOffersOnce`, `GrantLink`, `WithV2History`,
`ImportV2History`); android `jni/parvane_jni.cpp` (`startLinkOffer`,
`pollLinkGrantOnce`, `importV2HistoryLocked` — шов только принимает). Группы
новому устройству (п. 9): движок `share_groups_with_own_devices` /
`accept_group_key`; web `controller.ts` (`shareGroupsWithOwnDevices` из
`checkOwnDevices`); desktop и android — общее ядро `v2_session.cpp`
(`checkOwnDevicesLocked`). Тесты п. 9: движок
`client_flow.rs linked_device_gets_groups_from_own_device`, сценарии
`e2e_protocol_state_sync.mjs`, `desktop/verify_protocol_v2_link.sh`. Сервер:
`identity` (`store_link_offer`, `store_link_challenge`), `messenger`
(`authenticated_transfer_keys`). Тесты: web `linking.test.ts`, `v2LinkHistory.test.ts` +
`conformance.test.ts` (`LINK-1`), сценарий `scripts/e2e_protocol_state_sync.mjs`
(история до линковки видна на втором устройстве), desktop `tests/linking_tests.cpp` +
`tests/e2e_tests.cpp`, identity `link_v2_*`, messenger
`link_transfer_proves_old_key_only_with_valid_statement`.

## KEY-1. Смена ключа контакта — по виденным identity; signed_prekey только с подписью

**P-04 (TOFU).** Смена identity-ключа собеседника определяется ТОЛЬКО по
множеству уже виденных identity контакта (`seenIdentities` / `g_seenIds`),
а не по кэшу «контакт → primary identity»: тот перезаписывается при перечитке
каталога (`refreshContactDevices`) ещё до проверки — сервер, подменивший ключ,
прятал бы предупреждение. Каталог засевает множество только при первом
знакомстве (пусто); дальше в него попадают лишь identity, реально подтверждённые
входящими сообщениями (`rememberContactIdentity`). Новое устройство контакта —
тоже «смена ключа» (как safety number в Signal). Множество переживает
перезагрузку (персист рядом с контактами) и уезжает в экспорт линковки.

**P-25.** `signed_prekey` устройства из каталога используется для X3DH ТОЛЬКО
если `signed_prekey_sig` — валидная Ed25519-подпись base64-строки ключа
ключом `signing_key` того же устройства (то, что подписывает
`buildPrekeysPayload`). В списке `devices` подпись обязательна (пустой
`signing_key` не освобождает); legacy-бандл без списка устройств и без
`signing_key` проверить нечем — принимается как раньше. Устройство с невалидной
подписью пропускается (сессии нет, self-копии не шифруются); если каталог
целиком без валидных подписей — он считается недоступным: состояние не
перезаписывается, вердикт `verifySender` — `unknown` (не `spoofed`).

Реализации: web `e2e.ts` (`seenIdentities`, `rememberContactIdentity`,
`verifyPrekeySignature`, `refreshContactDevices`); desktop `parvane-core`
`e2e.cpp` (`g_seenIds`, `prekeySignatureValid`, `refreshContactDevices`) —
android использует то же ядро через `jni/parvane_jni.cpp`. Тесты: web
`e2eTrust.test.ts` + `conformance.test.ts` (`KEY-1`), desktop
`tests/e2e_tests.cpp` (rememberContactIdentity, P-25).

## SEND-1. Отправка E2E подписана, ack без sender, правка только тем же E2E-видом

**P-10.** В `msg.chat.send` E2E-сообщение с `sender_signing_key` несёт
`signature` — Ed25519-подпись строки `send:<message_id>:<ciphertext>` этим
ключом (`ciphertext` — из `content`, не из per-device копий). Messenger
отклоняет отправку без валидной подписи; без `sender_signing_key` (legacy)
подпись не нужна, но тогда запрещены self-копии с `signing_key`. Выборка
«своих исходящих» по signing-ключам в `msg.sync.request` ограничена
сообщениями того же владельца (`sender_user` по токену): чужой публичный ключ
в чужом сообщении в мою ленту не попадает.

**P-05.** `msg.chat.ack` не содержит `sender`: получатель не раскрывает серверу
расшифрованного отправителя; адрес для delivered сервер берёт из своей БД.

**P-22.** Правка E2E-сообщения принимает только тот же вид (`encrypted` ↔
`encrypted`, `group_encrypted` ↔ `group_encrypted`); понижение до plaintext
и legacy text-правка отклоняются и messenger'ом, и gateway'ем.

Реализации: web `messages.ts` (`signSend`), `sync.ts` (`sendAck`); desktop
`parvane-core` `SendPayload::signedStatement`, `MessengerClient::sendContent`
(параметр `signer`), `MessengerClient::ack`; tdesktop `E2eSigner()`; android
`jni/parvane_jni.cpp` (`e2eSigner`). Сервер: messenger `authenticate_send`,
`store_message_from`, `replace_message_content`, `edit_message`; gateway
`bind_client_payload`. Тесты: messenger
`authenticate_send_requires_signature_over_send_statement`,
`sync_by_signing_key_requires_same_sender_user`,
`edit_cannot_downgrade_encrypted_to_plaintext`; gateway
`plaintext_edits_are_rejected_fail_closed`; web `conformance.test.ts`
(`SEND-1`); desktop `tests/messenger_tests.cpp` (подпись send).

## EPHEMERAL-1. Typing и presence без утечки графа общения

**P-18.** Gateway разрешает подписку на `msg.typing.<id>` только для
собственного id (`id(self)` в обеих схемах: web FNV-32 и desktop/android
FNV-64/48) и для групп, где подписчик состоит (проверка по `group.list`
с токеном той же сессии; web-id группы — `-<fnv32("group:<gid>")>`,
desktop/android — `fnv48(<gid>)`). Подписка на чужой 1-на-1 typing раскрывала
бы, кто пишет жертве. `presence.*` запрещён: клиенты подписываются на
`presence.<id>` каждого известного собеседника (web — при первом появлении
адреса в сторе, desktop — в `RegisterPeer`, android — при доставке/отправке).
Публикация presence — только на свой `presence.<id(self)>`.

Реализации: gateway `allowed_sub`, `group_typing_allowed`,
`is_concrete_presence_subject`; web `connectionController.ts`
(`ensurePresence`, `store.onUserRegistered`); desktop `parvane_client.cpp`
(`EnsurePresenceSubscription`); android `jni/parvane_jni.cpp`
(`ensurePresenceSub`). Тесты: gateway `group_typing_ids_match_both_client_schemes`
и права подписки; web `conformance.test.ts` (`EPHEMERAL-1`).

## BLOB-1. Медиа-блоб — чанковый AEAD, окна плеера только из проверенных чанков

**P-24.** Раньше блоб шифровался одним AES-256-GCM целиком, а прогрессивный
плеер web расшифровывал окно как AES-CTR *без тега*: cloud/сервер бит-флипами
формировал произвольный вход медиа-декодера до проверки целого файла. Формат v2:
`"PVB2" | u32be chunkSize | for i in 0..n: ct_i | tag_i(16)`, где каждый чанк
(по умолчанию 256 КиБ; допустимо 1 КиБ…8 МиБ) — отдельный AES-256-GCM с
`nonce_i = nonce XOR (0^8 || u32be i)` и `AAD_i = "PVB2" | chunkSize | i | n`
(индекс и число чанков в AAD ловят перестановку и усечение). Ключ/nonce по-прежнему
едут в E2E-контенте (`file_key`/`file_nonce`), формат контента не меняется:
версия читается из заголовка блоба. Legacy v1 (`data || tag`) читается только
целиком после проверки тега; окно из v1 без проверки не отдаётся.

Вектор (`sync-rules.json → BLOB-1.vector`): ключ 32×0x01, nonce 12×0x02,
chunkSize 1024, plaintext 1500×`a` → 1540 байт, первые 24 байта
`505642320000040066b7a8282b36a09cb2addda93dc6a3d3`, последние 16
`297636bc1b79f4f72284144a0b0be7e8`. Legacy-вектор: `BLOB-1.legacyVector`.

Реализации: web `blobcrypt.ts` (`encryptBlobWithKey`, `decryptBlobChunks`,
`parseBlobHeader`; `media.ts` `downloadRange`), parvane-core `blobcrypt.cpp`
(`encryptWithKey`, `decryptChunks`, `parseHeader`; desktop и android зовут
`encrypt`/`decrypt`, версия определяется по заголовку). Тесты: web
`blobcrypt.test.ts`, parvane-core `blobcrypt_tests` (ctest `blobcrypt`),
`conformance.test.ts` (`BLOB-1`).

## STATE-1. Личное состояние сводится детерминированно

**Spec 007, R10, US5.** Папки, блок-лист, настройки уведомлений, черновики,
отложенные, архив/закреп и история звонков (D-08) хранятся в журнале личного
состояния (`state.append` / `state.sync`). Сервер хранит только шифртекст:
запись = `nonce(12) ‖ ChaCha20-Poly1305(StateOp)` на ключе личного состояния
(32 байта, общий для устройств пользователя; новому устройству передаётся
`StateKeyShare` внутри E2E при линковке/восстановлении), AAD =
`"parvane/v2/state\0" ‖ user ‖ op_id`. Запись под чужим user/op_id не
расшифровывается; op_id внутри операции обязан совпадать с op_id записи.

Сведение: каждый объект — LWW-регистр или LWW-карта по ключу (папка — `id`,
собеседник — пользователь/группа, отложенное — `op_id`, звонок — `call_id`,
закреп — список). Побеждает операция с большей меткой
`(lamport, device_id, op_id, sha256(байты StateOp))`; удаление — надгробие с
меткой. Отметка `scheduled_sent` необратима и сильнее любой метки. Некорректная
операция (плохой адрес, lamport 0 или > 2^53 − 1, зарезервированная папка 0/1,
неизвестный список закрепа) отвергается и не меняет состояние; неизвестный вид
операции пропускается. Итог — один и тот же на всех устройствах при любом
порядке, повторах и разбиении записей на порции.

Отложенные: отправляет первое устройство, заметившее срок; сообщение уходит с
`op_id` самого отложенного (дубль от второго устройства отсекается по op_id),
каждое устройство отправляет op_id не более одного раза (локальный
`SendGuard`), затем пишет в журнал `scheduled_sent`. При первом запуске
локальные данные клиента переводятся в начальные операции
(`migrate_snapshot`), испорченные записи пропускаются.

Реализация: движок `backend/protocol/src/state.rs` (`PersonalState`,
`seal_op`/`open_record`, `claim_due`, `migrate_snapshot`), схема
`proto/parvane/state/v1/state.proto`. Векторы: `proto/parvane/vectors/state/`
(`merge.json` — последовательности в разных порядках → одинаковый снимок,
`aead.json`, `scheduled.json`, `migration.json`). Случаи `merge.json`: ничья
лампорта → больший `device_id`; ничья `(lamport, device_id)` → больший `op_id`;
одинаковый `op_id` с разным содержимым → больший sha256; надгробие раньше
записи и воскрешение большей меткой; повторы; отвергнутые операции одинаковы
при любом порядке. Клиент обязан для КАЖДОГО порядка из `orders` получить
ровно `snapshot`, `rejected` и `max_lamport` из вектора. Тесты: движок
`backend/protocol/tests/state_vectors.rs` (векторы + property-тесты).

Сервер (T096, `backend/shards/messenger/src/v2_state.rs`): журнал
`user_state_log` хранит только `op_id` и шифртекст; `seq` — на пользователя
(общий для его устройств), монотонный. Повтор `state.append` с тем же `op_id`
и тем же шифртекстом возвращает прежний `seq` (повтор после обрыва безопасен),
с другим шифртекстом — `DUPLICATE`. Лимиты: запись 28…262144 байт, на
пользователя `PARVANE_STATE_MAX_RECORDS` (100000) и `PARVANE_STATE_MAX_BYTES`
(64 МиБ) → `LIMIT`. `state.sync {after_seq, max_bytes}` — страница с байтовым
бюджетом ≤ 716800 (как `msg.inbox.sync`), хотя бы одна запись; курсор клиента
— seq последней применённой записи (SYNC-1/SYNC-2). Живой тест —
`backend/tests/integration/tests/v2_state_live.rs`.

Web переведён (T098): `src/api/parvane/v2/stateJournal.ts` ведёт папки,
блок-лист, черновики, отложенные и архив/закреп журналом (при первом запуске
v2 локальные данные переносятся `migrate`), векторы `merge.json` проходят
через WASM-движок (`stateVectors.test.ts`, набор `state/merge` в
`backend/protocol/src/conformance.rs`). Desktop (29 сен 2026): ctest
`protocol_vectors` (набор `state/merge` через C ABI), журнал — папки и
отложенные (`parvane_client.cpp`), проверка — `tests/run_v2_session_live.sh` и
`desktop/verify_protocol_v2_groups.sh` (папка возвращается из журнала).
Android: JVM `ProtocolV2SeamTest` (`state/merge` через JNI) и `StateJournalTest`
(папки, блок-лист, черновики, архив, отложенные — `StateJournal.kt`). Тесты во
всех трёх клиентах есть — правило закрыто.

## SEAL-1. Скрытый отправитель: конверт вскрывает только адресат

**Spec 007, R6, D-05, класс 11.** Личное сообщение v2 — `SealedEnvelope`:
HPKE RFC 9180 (base, DHKEM X25519 + HKDF-SHA256 + ChaCha20-Poly1305),
`info = "parvane/v2/sealed\0" ‖ address ‖ "\0" ‖ device_id`. Снаружи —
только устройство-адресат, право доставки (ключ доставки или анонимный
жетон) и размер; внутри — сертификат устройства отправителя и Olm-сообщение.
Клиент обязан: (1) вскрывать конверт только если `recipient` = своё
устройство (иначе `ContextMismatch`, конверт не показывается); (2) отвергать
любой повреждённый конверт (`Crypto`); (3) после Olm проверять подпись
операции сертификатом из журнала устройств автора и адресата в
`header.audience` (класс 6); (4) отправлять через анонимный канал по одному
получателю на запрос (D-05), свои устройства — отдельными запросами; (5) в
L2-режиме выравнивать внутренний слой по сетке 512/2048/8192/32768.

Векторы: `proto/parvane/vectors/seal/sealed.json` (вскрытие, L2-выравнивание,
порча, чужое устройство). Сверка — движком (`parvane_protocol::conformance`,
набор `seal/sealed`) через обвязку клиента: web —
`src/api/parvane/protocol.vectors.test.ts` (WASM), desktop —
`desktop/parvane-core/tests/protocol_vectors_tests.cpp` (ctest
`protocol_vectors`, C ABI), android — JVM
`libtd/src/test/.../ProtocolVectorsTest.kt` (JNI → C ABI). Сторож
`conformance.test.ts` проверяет, что набор назван в тесте каждого клиента.

## GSEAL-1. Групповой конверт эпохи: автор неразличим для сервера

**Spec 007, R8, D-07.** Групповое сообщение v2 — `GroupEnvelope`: Megolm
внутри AEAD ChaCha20-Poly1305 на ключе конверта эпохи (nonce 16 байт, AAD —
группа, эпоха, nonce), подпись ключом отправки эпохи (общим для участников).
Сервер проверяет эпоху (`Expired` при несовпадении, при устаревшей эпохе после
бана/исключения — тоже `Expired`) и подпись (`BadSignature`), отказывает в
повторе `envelope_nonce` (`Duplicate`) и рассылает ВСЕМ участникам, включая
устройства автора. Клиент: снимает AEAD ключом своей эпохи, затем Megolm и
проверку автора по журналу группы и журналу устройств (класс 19, D-03 —
форк состояния группы обнаруживается по `GroupContext`); квитанции в группах —
тоже групповыми конвертами; «печатает» — через анонимный канал с подписью
ключом отправки эпохи.

Векторы: `proto/parvane/vectors/seal/group.json` (проверка+вскрытие, порча
шифртекста, чужая эпоха). Сверка — набор `seal/group` тем же способом, что
SEAL-1.

## CONTENT-1. Вид содержимого одинаков во всех клиентах

**Spec 007, FR-004, FR-006, SC-004 (T085).** Вид сообщения описан один раз —
в `proto/parvane/msg/v2/content.proto`; клиенты не разбирают байты сами и
одинаково решают, чем вид является для пользователя:

- `message` — сообщение чата (текст, медиа всех видов, стикер, геопозиция,
  опрос, голос в опросе, закрытие опроса); перекладка в содержимое UI даёт те
  же поля во всех клиентах (`kind`, `file_id`, `mime`, `size_bytes`,
  `duration_secs` с округлением ≥ 1 с, `waveform`, `lat`/`long`, …);
- `mutation` — правка, удаление, реакция, закреп, квитанция: меняют уже
  показанное сообщение, сами не показываются;
- `service` — ключи группы, доставки, личного состояния, контейнера и сигналы
  звонка: в чат не попадают;
- `stub` — вид, который клиент не умеет показать (сегодня — контакт), пустое
  содержимое, вид из будущей версии или неизвестное поле, объявленное автором
  критичным: нативная заглушка «сообщение не поддерживается», следующее
  сообщение доставляется. Молча отбрасывать такой вид нельзя.

Превышение лимита поля — отказ до разбора (`FieldLimit`); каноничный
proto3-JSON собирается обратно в те же байты.

Векторы: `proto/parvane/vectors/content/kinds.json` — каждый вид `Content` и
общие поля (тест движка `backend/protocol/tests/vectors_content.rs` падает,
если у нового вида нет вектора или файл не перегенерирован). Сверка — набор
движка `content/kinds` плюс поле `client` вектора (класс и поля содержимого
UI) тестом каждого клиента — теми же файлами, что у SEAL-1.

## L2-1. Режим «усиленная приватность»: сетка размеров, согласование, без typing/presence

**Spec 007, FR-036 (T076, T079).** Режим чата, в котором сервер видит меньше
метаданных. Сервер режима не знает и узнать не должен; время приёма всех
sealed- и групповых записей он округляет до минуты независимо от режима.

1. **Сетка.** При активном режиме исходящие конверты чата — личные (внутренний
   слой sealed) и групповые (внутренний слой конверта эпохи), включая
   квитанции, раздачу ключей и саму смену режима — выравниваются ТОЧНО до
   512 / 2048 / 8192 / 32768 байт, дальше — до кратного 32768. Корзина, в
   которую точно попасть нельзя (остаток 2 байта, границы varint длины
   заполнения), пропускается — берётся следующая: размер «рядом с сеткой»
   выдал бы длину. Выравнивает движок (`seal::l2_padding_len`), клиент
   размеров не считает.
2. **Согласование.** Личный чат: предпочтение участника — подписанная
   E2E-операция `Content.chat_mode {l2}` собеседнику и своим устройствам;
   у каждого участника своё предпочтение, новее — по метке операции, при
   равных метках выигрывает включение. Режим активен, пока он включён ХОТЯ БЫ
   у одного участника (выравнивает отправитель, а защищает это получателя).
   Предпочтение постороннего не действует. Группа: политика — запись журнала
   группы `set_privacy_mode {l2}`, право — как у изменения сведений
   (`change_info`), проверяется движком и сервером по состоянию до записи;
   новой эпохи не требует. `chat_mode` в групповом конверте не действует и не
   показывается. `chat_mode`, пришедший по v1, отбрасывается.
3. **Эфемерные каналы.** При активном режиме чата клиент НЕ шлёт «печатает» в
   этот чат и не показывает чужой, не подписывается на присутствие
   собеседника и не показывает его «в сети». Своё присутствие одно на аккаунт,
   поэтому не публикуется, пока режим активен хотя бы в одном чате. Решение
   действует с запуска клиента: последнее известное состояние хранится на
   устройстве и применяется до готовности v2-сессии.
4. **Видимость.** Смена режима — видимое служебное сообщение чата у всех
   участников и на своих устройствах («… включил(а)/выключил(а) усиленную
   приватность»; содержимое UI `{"kind":"chat_mode","l2":bool}`, CONTENT-1);
   в группе — от имени того, кто задал политику, один раз на изменение.
   Переключатель — нативный пункт профиля чата (своё предпочтение; если режим
   включён собеседником — подпись об этом) и управления группой (политика).

Векторы: `proto/parvane/vectors/l2/mode.json` (набор движка `l2/mode`: размеры
после выравнивания личных и групповых конвертов на границах корзин и varint,
согласование — порядок операций, равные метки, посторонний, политика группы и
личное предпочтение); случаи `chat-mode-on`/`chat-mode-off` в
`content/kinds.json`. Движок — `backend/protocol/tests/vectors_l2.rs`,
сценарий `l2_mode_direct_and_group` в `backend/protocol/tests/client_flow.rs`,
сервер — `backend/tests/integration/tests/v2_l2_live.rs`. Клиенты: набор
`l2/mode` тем же тестом, что SEAL-1; поведение — web
`src/api/parvane/l2.test.ts`, desktop `desktop/parvane-core/tests/v2_tests.cpp`
(состояние, содержимое) и `desktop/verify_protocol_v2.sh` (шаги L2), android
`L2PrivacySeamTest.kt` и `android/tgx_protocol_v2_flow.sh`.

## CALL-1. ICE-кандидат звонка: один формат во всех клиентах

Сигнал `{"type":"ice","call_id":…,"candidate":"<JSON-строка>"}` (личные и
групповые звонки). Внутри строки — объект кандидата:

- канонические поля: `candidate` (строка `candidate:…`), `sdp_mid`,
  `sdp_mline_index` — те же имена, что в `proto/parvane/call/v2/call.proto`;
- клиент ПИШЕТ рядом прежние имена — web `sdpMid`, `sdpMLineIndex`
  (`RTCIceCandidateInit`) и desktop `sdp`, `mid`, `idx`, — чтобы выпущенные
  версии продолжали понимать новые;
- клиент ЧИТАЕТ любой из трёх видов; не JSON-объект или объект без строки
  кандидата молча пропускается, звонок от этого не рвётся.

До 2 окт 2026 web писал только вид `RTCIceCandidateInit`, desktop — только
`{sdp, mid, idx}`, и чужих кандидатов клиенты не понимали: звонок web ↔
desktop не соединялся (ICE оставался в `new`), а автоматического сценария
такого звонка не было. Вторая часть правила — ответ на вызов обязан нести
звук отвечающего (`a=sendrecv`): desktop добавлял трек через `AddTransceiver`,
который не привязывается к секции входящего оффера, и отвечал `a=recvonly`.

Реализации: web `src/api/parvane/iceCandidate.ts` (`encodeIceCandidate`,
`decodeIceCandidate`; `callengine.ts`, `groupcall.ts`), desktop и ядро
`parvane-core/include/parvane/call.h` (`iceCandidateJson`, `parseIceCandidate`;
`parvane_webrtc_backend.cpp`). В Android звонков нет (спека 006). Тесты: web
`iceCandidate.test.ts`, ядро `call_session_tests.cpp`, сторож
`conformance.test.ts`, сценарий `scripts/run_web_cross_calls_e2e.sh`.

## LEGACY-1. v1-устройства аккаунта, перешедшего на v2

**Spec 007, FR-054/FR-058 (2 окт 2026).** Пока у аккаунта остаются устройства
на v1, сообщение v2-отправителя обязано дойти и до них — и ни до кого больше.

1. **Список.** Первое v2-устройство аккаунта публикует в журнале устройств
   запись `LegacyDeviceSet` — свои v1-устройства из каталога identity
   (`identity.device.list`: `device_id`, identity- и signing-ключ), подписанную
   SSK. Дальше список только сокращается (устройство перешло на v2 или исчезло
   из каталога); появившееся позже v1-устройство копий не получает. Свой журнал
   запись получает синком — после подтверждения сервера.
2. **Отправка.** После v2-отправки личного сообщения клиент шифрует ту же
   запись (v1 `MessageContent`, тот же id) по v1 (Olm) ТОЛЬКО для устройств из
   подписанных списков собеседника и своего, у которых identity-ключ в каталоге
   v1 совпал с ключом из списка, и отправляет методом v2 `msg.deliver_legacy`
   (v1 `SendPayload`: `content.kind = encrypted`, **основной `ciphertext`
   пуст**, всё адресное — в `copies`; подпись SEND-1 — `send:<id>:`). Сбой
   копии не роняет отправку. Правка и удаление «у всех» дублируются v1-топиками
   `msg.chat.edit` (пустой основной шифртекст + копии, подпись `edit:<id>:`) и
   `msg.chat.delete`.
3. **Приём.** Запись v1 вида `encrypted` с пустым основным шифртекстом, для
   которой у устройства нет своей копии, — чужая легаси-копия: устройство её
   молча пропускает (подтверждает приём, заглушку «не расшифровано» не рисует,
   курсор SYNC-1 не держит). Это же относится к её надгробию.

Реализации: движок `legacy_devices_request` / `legacy_deliver_request` /
`log_devices_json` (`legacySet`, `legacyKeys`); web `v2/controller.ts`
(`syncLegacySet`, `deliverLegacy`), `messages.ts` (`sealLegacy`), `sync.ts`
(пропуск); ядро `parvane-core` `v2_legacy.{h,cpp}`, `e2e.cpp`
(`sealLegacyCopies`, `isForeignLegacyCopy`), `v2_session.cpp`
(`syncLegacySet`); tdesktop и Android JNI зовут ядро. Тесты: движок
`client_flow.rs legacy_device_set_is_signed_and_only_shrinks`, ядро
`v2_tests.cpp`, `e2e_tests.cpp`, сторож `conformance.test.ts`, сценарий
`scripts/run_protocol_mixed_e2e.sh mixed-devices` (пара удалена с T110: web легаси-копий не шлёт).

## TYPING-1. «Печатает» в чате v2 — только эфемерным каналом v2

**Spec 007, FR-013/FR-064, D-07 (2 окт 2026).** Кадр v1 `msg.typing.<chatId>`
несёт серверу открытые `{from, to}` из сессии с личностью. В чате v2
(собеседник с журналом устройств либо группа `v2g:`) клиент шлёт «печатает»
только эфемерным каналом v2:

- личный чат — `ephemeral.typing` в канал, выведенный из ключей доставки обоих
  собеседников; группа — `ephemeral.group_typing` анонимным каналом, канал из
  ключа конверта текущей эпохи, подпись ключом отправки эпохи;
- payload запечатан на ключ канала и дополнен до фиксированного размера;
  автора проверяет движок (в личном канале — только собеседник, в группе —
  участник), сигнал старше 30 с отбрасывается;
- **понижения до v1 нет**: канала ещё нет (ключ доставки собеседника не
  получен), сбой v2 или чат в L2 — «печатает» не уходит никак;
- подписка — `ephemeral.subscribe` на каналы известных чатов, заново после
  переподключения и после смены эпохи группы.

Присутствие (`presence.<id>`, только свой адрес) в переходный период остаётся
на v1; движок уже умеет канал присутствия v2 (`presence_request`).

Реализации: движок `client.rs` (`eph_subscribe`, `typing_request`,
`group_typing_request`, `open_ephemeral`), обвязки `ephSubscribe/ephTyping/
ephOpen` (WASM) и `pv_client_eph_*` (C ABI); web `v2/controller.ts`
(`trySendTyping`, `ensureEphemeral`), `messages.ts` (`sendMessageAction`);
ядро `v2_session.cpp` (`sendTyping`); tdesktop `MirrorTyping`, Android JNI
`nativeSendTyping`. Тесты: движок `client_flow.rs
ephemeral_typing_and_presence`, ядро `v2_session_tests.cpp` (живой), web
`l2.test.ts`, сторож `conformance.test.ts`, сценарии
`scripts/run_protocol_mixed_e2e.sh web2-web2` и `web2-groups` (нет кадров
`msg.typing.*`).

## REVOKE-1. Отзыв своего устройства на v2

**Spec 007, FR-066; D-11, D-12, D-16 (2 окт 2026).** Отзыв устройства — не
только v1-топик: устройство держало ключи, и они обязаны смениться.

1. **Список.** Settings → Devices показывает каталог v1 ПЛЮС устройства
   журнала v2: у аккаунта на v2 новое устройство в каталог v1 не попадает
   (защита от downgrade, T048), иначе его не видно и не отозвать.
2. **Отзыв.** Сначала `identity.device.revoke` (проверка пароля P-07, тумбстоун
   JWT; для устройства только из журнала v2 сервер отвечает `ok`), затем движок
   `revoke_device`: первый запрос — запись отзыва в журнале устройств
   (обязателен; при отказе клиент поднимает состояние движка заново из
   сохранённого), остальные — ротации: ключ доступа к доставке (сервер, свои
   устройства, собеседники), ключ личного состояния, новые эпохи групп, где мы
   админ. Отложенное (`pendingKeyShares`, `pendingEpochs`) клиент доделывает
   сам. Сбой v2-части устройство не «возвращает».
3. **Журнал состояния.** После смены ключа состояния старые записи новым
   ключом не читаются. Отзывавшее устройство переносит сведённое состояние
   записями под новым ключом; остальные свои устройства НЕ применяют пустой
   снимок — ждут записей под новым ключом (либо переносят своё локальное).
4. **SSK.** Отозвано устройство, державшее SSK (любое привязанное грантом) —
   журнал не принимает новые устройства и список v1-устройств, пока SSK не
   сменён корнем (`rotate_ssk`). Корень: на первом устройстве без ключа
   восстановления (desktop) — в файле, меняется сразу; иначе — из копии под
   ключом восстановления, которую ввёл пользователь (web: Settings → Devices,
   блок «Device signing key»). Копия корня едет в гранте линковки (поле `rb`,
   функции движка `grant_with_root_backup` / `grant_root_backup`), чтобы SSK
   мог сменить не только первый клиент. Неверный ключ отклоняется; корень в
   памяти — только на время операции.

N. **Выход устройства (6 окт 2026, T197).** При полном выходе устройство само
   убирает себя из журнала: запись `RevokeDeviceId(свой id)`, подписанная КЛЮЧОМ
   УСТРОЙСТВА (`olm_ed25519` сертификата), а не SSK. Такая запись SSK раскрытым
   НЕ делает (ключ восстановления оставшимся устройствам не нужен); чужое
   устройство своим ключом другое убрать не может. Идентификатор вышедшего
   устройства назад не принимается — следующий вход идёт новым устройством.
   Устройство, выдающее грант линковки, перед выдачей перечитывает свой журнал.
   Движок `identity.rs` (`by_itself`), `Client::leave_request`; обвязки `leave`
   (WASM), `pv_client_leave` (C ABI). Реализовано в web (`v2Controller.leave` в
   `destroy`); desktop — в ядре `Session::leave` (живой тест `v2_session_tests.cpp`,
   ENG-04), но полный выход tdesktop его не зовёт — ОТКРЫТО; android — T193.

N+1. **Ревью 7 окт, ENG-04…08 (15 окт 2026, движок — общий для всех клиентов).**
   - Признак «держал SSK» не снимается более поздним сертификатом с `no-ssk`;
     вышедшее само устройство-держатель владелец может отметить украденным
     (повторный отзыв подписью SSK → SSK раскрыт, п. 4). Web: «Устройства» →
     «Signed-out devices» (`report_device_stolen`, `left_ssk_holders`).
   - Запись журнала группы несёт `signer_log_version` — версию журнала устройств
     подписанта; проверяется ключом, действовавшим в этой версии (`DeviceLog.eras`):
     выход/отзыв подписавшего устройства группу не ломает. Версии пользователя в
     журнале группы не убывают — отозванное устройство не пишет после записи,
     сославшейся на его отзыв.
   - Сообщение несёт `OpHeader.author_log_version`; получатель, знающий журнал
     автора старее, догоняет его до следующей отправки этому пользователю.
   - Уход устройства участника группы сбрасывает свою Megolm-сессию группы и
     требует новой эпохи (`groupInfo.epochStale`); раздача Megolm-ключа уходит и
     своему отправляющему устройству (обманка, ENG-07). Web, кроме того, отправляет
     первый конверт новой сессии через случайные 0,8–2,5 с после раздачи
     (`GROUP_SHARE_GAP_*` в `v2/controller.ts`), чтобы сервер не связывал их по времени.
   Desktop (spec 029): ядро `reportDeviceStolen`, `leftSskHolders`, кнопка — экран
   «Устройства» (`parvane_account_ui.cpp`, `FillReadyExtras`), живой тест
   `v2_session_tests.cpp` (ENG-04). Android получает это со следующей сборкой движка
   (C ABI прежний; кнопки «устройство украдено» нет — ОТКРЫТО).

N+2. **Два способа завершить сеанс (15 окт 2026, решение владельца).** «Завершить
   сеанс» и «Завершить все другие сеансы» спрашивают, как именно:
   - «Просто выйти» (по умолчанию) — запись отзыва подписью SSK с признаком
     `UserDeviceLogEntry.sign_out = 9`: журнал считает её выходом самого устройства
     (SSK не раскрыт, устройство — среди вышедших держателей, п. N+1), ключи
     доставки/состояния/доменов не меняются, группам — новая эпоха (ENG-06).
     Движок `sign_out_device`, WASM `signOutDevice`. Признак действует только на
     действующее устройство: «украдено» им не снимается;
   - «Выйти и сменить ключи» — прежний отзыв с ротациями (п. 1–4).
   Позже вышедшее так устройство можно отметить украденным (п. N+1). Старый движок
   (desktop/android до пересборки, сервер до деплоя) читает такую запись как обычный
   отзыв — SSK раскрыт, новые устройства до смены SSK не принимаются; поэтому сервер
   выкатывается вместе с web.

Реализации: движок `client.rs` (`revoke_device`, `rotate_ssk_with_secret`,
`own_ssk_exposed`), обвязки `revokeDevice/shareDeliveryKey/rotateSsk/
ownSskExposed/grantWithRootBackup/grantRootBackup` (WASM) и `pv_client_revoke_device`,
`pv_client_share_delivery_key`, `pv_client_rotate_ssk`, `pv_client_own_ssk_exposed`,
`pv_grant_*` (C ABI); identity `devices.rs` + `v2::log_has_device`; web
`v2/controller.ts` (`revokeDevice`, `rotateSsk`, `sskState`), `provider.ts`
(`fetchAuthorizations`, `revokeOwnDevice`), `v2/stateJournal.ts` (`attach(host,
rekey)`), `SettingsActiveSessions.tsx`; ядро `v2_session.cpp` (`revokeDevice`,
`rotateSsk`, `sskState`, `ownDevices`, `stateRekeyed_`); tdesktop `ListDevices`/
`RevokeDevice`, Android JNI `nativeListDevices`/`nativeRevokeDevice`. Тесты:
движок `revocation_flow.rs`, ffi `grant_carries_root_backup`, ядро
`v2_session_tests.cpp` (живой, T128), сторож `conformance.test.ts`, сценарий
`scripts/run_protocol_mixed_e2e.sh revoke`.

## RECOVER-1. Смена корня собеседника и новое устройство без других устройств

**Spec 007, FR-019/FR-066; D-11, D-12 (2 окт 2026).**

1. **Отпечаток журнала.** Ответ `identity.device.log_sync(_anon)` несёт
   `genesis_hash` — SHA-256 первой записи текущего журнала устройств. Клиент,
   знающий другой генезис, получает от движка вердикт `replaced` и перечитывает
   журнал с версии 0; полный журнал с ДРУГИМ корнем — `rootChanged`, с прежним
   корнем — отказ (откат/форк, D-11).
2. **KEY-1 v2.** На `rootChanged` (и на потребность движка `rootChanged`)
   клиент показывает в чате то же служебное сообщение, что при смене ключа в v1
   («ключ безопасности изменился»), и принимает новый журнал
   (`accept_root_change`); прежние сессии с собеседником отбрасываются. Молча
   журнал с новым корнем не принимается никогда.
3. **Прежние устройства при сбросе.** Сервер на `identity.root.rotate`
   отзывает все устройства прежнего журнала (тумбстоун JWT, запись каталога
   v1, сессии v2) — иначе новое первое устройство внесло бы «потерянные»
   устройства в подписанный список v1-устройств (LEGACY-1), и им продолжали бы
   уходить копии сообщений. Клиент, увидевший, что его журнал заменён (вердикт
   `replaced` для своего адреса — при запуске и по ходу работы), стирает
   состояние движка и переходит в «нужна линковка».
4. **Ключ доступа отвергнут.** `FORBIDDEN` на запечатанной доставке личного
   чата = собеседник сменил ключ доступа (отзыв устройства, восстановление,
   сброс): клиент зовёт `delivery_key_rejected` и повторяет отправку со слепым
   жетоном; без этого отправка такому собеседнику падала навсегда.
5. **Копия корня на сервере.** Устройство, у которого есть копия корня под
   ключом восстановления, кладёт её на сервер (`identity.root.backup_set`;
   пишет только активное устройство журнала). Сервер хранит шифртекст.
6. **Новое устройство, других устройств нет** (состояние «нужна линковка»):
   - *ключ восстановления* — `identity.root.backup_get` → корень из копии →
     `recover_with_root`: корень назначает новый SSK, прежние устройства
     отзываются записями журнала, устройство сертифицирует себя, ключ доступа
     новый; собеседники KEY-1 НЕ видят (корень прежний). Неверный ключ
     отклоняется, без копии — `no_backup`;
   - *сброс личности* — `identity.session.reauth` (пароль) → `reset_identity`:
     первый запрос `identity.root.rotate` (новый генезис взамен журнала), новый
     ключ восстановления показывается пользователю; собеседники видят KEY-1.
7. **Копия корня для администратора (5 окт 2026, T192).** Сервер может
   объявить открытый ключ администратора (`ServerDescribeResponse.escrow_public_key`,
   X25519; env `PARVANE_ESCROW_PUBLIC_KEY`). Тогда клиент каждый раз, когда корень
   есть в памяти (создание и сброс личности, вход и смена SSK по ключу
   восстановления), запечатывает его этим ключом (`seal_root_escrow`: HPKE,
   `info` привязан к адресу) и отдаёт серверу полем `escrow` того же
   `identity.root.backup_set`. Закрытый ключ — у администратора, вне сервера.
   Пользователь, потерявший ключ восстановления, пишет администратору:
   `scripts/admin_recover_user.sh` открывает копию, выписывает НОВЫЙ ключ
   восстановления и кладёт на сервер копию корня под ним; дальше — обычный
   вход по ключу (пункт 6), корень прежний, KEY-1 собеседники не видят. Смена
   SSK при негодном ключе пробует копию с сервера (ключ мог быть выписан
   заново). Экраны говорят «ключ утерян — напишите администратору». Реализовано
   в web (`sealRootEscrow`, сценарий `run_protocol_mixed_e2e.sh escrow`);
   desktop — ядро `sealRootEscrowLocked` (создание и сброс личности, `storeEscrowCopy`),
   сценария нет; android — T193 (обвязка `pv_client_export_root_escrow` готова).

Реализации: движок `client.rs` (`ingest_log_sync`, `log_genesis`,
`accept_pending_root`, `recover_with_root`, `reset_identity`), обвязки
`ingestLog` (вердикт `replaced`), `acceptRootChange`, `deliveryKeyRejected`,
`importRootBackupFor`, `recoverWithRoot`, `resetIdentity` (WASM) и
`pv_client_accept_root_change`, `pv_client_delivery_key_rejected`,
`pv_import_root_backup_for`, `pv_client_recover_with_root`,
`pv_client_reset_identity` (C ABI); identity `v2.rs` (`genesis_hash`,
`identity.root.backup_set/get`, миграция `0003_root_backup.sql`); web
`v2/controller.ts` (`acceptPeerRoot`, `runDirect`, `dropIdentity`,
`uploadRootBackup`, `recoverWithKey`, `resetIdentity`), блок «No other
device?» в `SettingsActiveSessions.tsx`; ядро `v2_session.cpp`
(`acceptPeerRootLocked`, `runDirectLocked`, `dropIdentityLocked`,
`uploadRootBackupLocked`, `recoverWithKey`, `resetIdentity`), tdesktop — событие
`peerRootChanged` → `AnnounceKeyChange`, Android JNI — событие
`peer_root_changed`. Ввод ключа восстановления и сброс в UI desktop — окно
«Подтвердите вход» (`parvane_account_ui.cpp` `FillLinking` → `RecoverWithKey`,
`ResetIdentityWithPassword`, spec 029); Android — T140.
Тесты: движок `revocation_flow.rs` (`recovery_with_root_replaces_devices`,
`identity_reset_is_seen_as_root_change`), ядро `v2_session_tests.cpp` (живой,
T129/T130), сторож `conformance.test.ts`, сценарии
`scripts/run_protocol_mixed_e2e.sh recovery`, `desktop/verify_protocol_v2_reset.sh`.

## CAP-1. Блобы вложений v2-чата — по секрету capability, без гранта получателю

**Spec 007, FR-062, D-08 (2 окт 2026).** Грант «файл → получатель» в cloud —
серверная запись «отправитель–получатель» в обход скрытого отправителя.

1. **Когда.** Чат v2 (собеседник с журналом устройств либо группа `v2g:`) и ни
   у собеседника, ни у себя нет v1-устройств в подписанных списках (LEGACY-1).
   Иначе (чат v1, «Избранное», есть v1-устройства) — как раньше: v1-загрузка с
   грантами получателям.
2. **Загрузка.** Шифртекст блоба (blobcrypt, BLOB-1) уходит методами v2
   `cloud.blob.upload_chunk` / `cloud.blob.upload_complete` (ID-канал,
   `VISIBILITY_PRIVATE`) с `capability_hash = SHA-256(capability)`;
   `capability` — 32 случайных байта. Получатели серверу не называются.
3. **Содержимое.** Секрет едет ТОЛЬКО внутри E2E: `content.capability`
   (base64; в схеме v2 — `Media.capability`), у ссылки на пак —
   `pack_ref.capability` / `emoji_packs[].capability` (`PackRef.capability`).
   При пересылке блоб перезаливается с новым секретом.
4. **Скачивание.** Клиент, знающий секрет файла, качает его
   `cloud.blob.download_cap` анонимным каналом, одноразовое соединение на
   запрос (≤ 256 чанков); v1-скачивание — только если секрета нет (свой файл
   либо файл с грантом). Реестр `file_id → секрет` восстанавливается из
   расшифрованного содержимого после перезапуска.

Реализации: web `media.ts` (`uploadBlob({withCapability})`,
`fetchChunkRangeCap`, `downloadBlobByCap`, `rememberKeys`), `messages.ts`
(`mediaUploadOptions`), `v2/controller.ts` (`uploadBlob`, `downloadBlobCap`),
`v2/contentMap.ts`; ядро `v2_link.cpp` (`Connection::requestStream`),
`v2_session.cpp` (`uploadBlob`, `downloadBlobCap`), `v2_content.cpp`; tdesktop
`BlobRecipientsFor` / `UploadBlobWith` / `DownloadChatBlob` / `RememberBlobCaps`;
Android JNI `rememberBlobCaps` / `downloadChatBlob` и ветка capability в
отправке медиа (архивы паков с Android — пока с грантами: получателей задаёт
Kotlin). Тесты: ядро `v2_session_tests.cpp` (живой, T131), сторож
`conformance.test.ts`, сценарий `scripts/run_protocol_mixed_e2e.sh web2-web2`
(в `cloud.db` нет строк `file_grants`).

## STATE-2. Личное состояние — целиком в журнале, открытому серверу не отдаётся

**Spec 007, FR-039, FR-040 (2 окт 2026).** До правила настройки уведомлений
(кто заглушён) лежали на сервере открытым v1-блобом `msg.chat.setnotify`,
блокировка и архив на десктопе жили только в памяти, а приватность каждое
устройство держало у себя и перетирало чужой выбор.

1. **Виды журнала.** Клиент, подключивший журнал личного состояния (STATE-1),
   ведёт в нём: папки, блок-лист, отложенные, архив, закреп основного списка
   (`PIN_LIST_MAIN`) и настройки уведомлений (`notify` — исключения по чатам,
   `notify_defaults` — умолчания по типам; `state.v1.NotifySettings`:
   `mute_until_ms`, `sound`, `show_previews`, `silent`). Правка на одном
   устройстве видна на другом ≤ 10 с (опрос `state.sync` раз в 8 с).
2. **v1-блоб.** Пока у аккаунта нет v1-устройств (LEGACY-1), в
   `msg.chat.setnotify` уходит только то, что обязан исполнять сервер
   (`group_add`); списка заглушённых чатов в нём нет. Есть v1-устройства — блоб
   полный (иначе они потеряют настройки).
3. **Отметка «непрочитано» и быстрая реакция (22 окт 2026).** Чат, отмеченный
   «непрочитанным» вручную, — запись `unread_mark_set` по собеседнику; открытие
   чата на любом своём устройстве снимает отметку (`unread_mark_remove`), и
   остальные снимают её у себя. Быстрая реакция (двойной щелчок) — регистр
   `quick_reaction`: эмодзи либо id собственного эмодзи, не оба; пустой —
   реакция клиента по умолчанию (👍). Виды хоста — `unread`, `reaction`.
4. **Новый вид на старой установке.** Вид, которого журнал ещё не содержит,
   переносится из локальных данных один раз (маркер на устройстве); пустая
   проекция такого вида локальные данные не стирает.
5. **Приватность — на сервере.** `identity.privacy.set` перезаписывает все
   поля; устройство при готовности сессии читает `identity.privacy.get` и
   принимает серверное значение. Своя правка, не дошедшая до сервера,
   досылается и сильнее прочитанного. Экран настройки перед показом
   перечитывает значение.

Реализации: web `v2/stateJournal.ts` (`notifyToState`/`notifyFromState`,
`projectNotify`, `projectUnreadMarks`, `projectQuickReaction`, `migrateLateKinds`), `provider.ts` (`toggleDialogUnread`, `fetchConfig`/`setDefaultReaction`,
`refreshV2Privacy`), `v2/controller.ts` (`getPrivacy`); ядро `v2_session.cpp`
(`fetchPrivacyLocked`, события `privacy`/`privacySaved`); tdesktop
`parvane_client.cpp` (`kV2StateKinds`, `ProjectNotify`, `ProjectBlocked`,
`ProjectDialogs`, `MirrorBlock`/`MirrorArchive`/`MirrorDialogPins`,
`PublishNotifyBlob`, `PrivacyLocal.dirty`); Android — блок-лист и архив в
`StateJournal.kt`, уведомления и закреп — ещё нет (правило открыто). Тесты:
ядро `v2_session_tests.cpp` (FR-040, живой), сторож `conformance.test.ts`,
сценарии `scripts/run_protocol_mixed_e2e.sh state-sync` и
`desktop/verify_protocol_v2_state.sh`.

## ACCESS-1. Блокировка отзывает ключ доступа; жетоны — партиями по расписанию

**Spec 007, FR-033, FR-063, D-06 (2 окт 2026).** Блокировка на клиенте только
скрывала входящие: заблокированный по-прежнему держал ключ доступа к доставке
и писал «как контакт», мимо анти-спам квот. Жетоны клиенты просили прямо перед
тратой — выдача (с личностью) связывалась по времени с анонимной доставкой.

1. **Блокировка.** Клиент, блокируя собеседника в чате v2, зовёт движок
   `revoke_contact_access(peer)`: новый ключ доступа → `identity.delivery_key.set`
   → своим устройствам → всем, кому раздавался прежний, КРОМЕ заблокированного.
   Собеседнику, у которого ключа не было, отзывать нечего. Сервер новый ключ не
   принял — состояние движка поднимается заново из сохранённого.
2. **После отзыва.** Заблокированный может писать только как незнакомый
   (анонимный жетон), а при запрете «сообщения от незнакомых» — никак.
   Разблокировка ключ не возвращает: он раздаётся со следующим своим сообщением.
3. **Жетоны.** Партия запрашивается, когда наступил срок по расписанию движка
   (`token_refill_due`; проверка при готовности сессии и раз в час), размером
   не больше 20 (квота на аккаунт делится между его устройствами). Неудача
   повтор не ускоряет. Запрос перед тратой остаётся только запасным путём при
   пустом запасе.

Реализации: движок `client.rs` (`revoke_contact_access`), обвязки
`revokeContactAccess` / `pv_client_revoke_contact_access`, `tokenRefillDue` /
`tokenBatchSize`; web `v2/controller.ts` (`revokeContactAccess`,
`refillTokens`), `provider.ts` (`blockUser`); ядро `v2_session.cpp`
(`revokeContactAccess`, `refillTokensLocked`, `scheduleTokenCheck`); tdesktop
`NoteBlock`; Android JNI `nativeRevokeContactAccess` (Kotlin его ещё не зовёт —
правило открыто). Тесты: движок `revocation_flow.rs`
(`contact_access_revocation_excludes_one_peer`), ядро `v2_session_tests.cpp`
(T133, живой), сторож `conformance.test.ts`, сценарии `state-sync` и
`desktop/verify_protocol_v2_state.sh`.

## GROUP-3. Группа v2: сведения только из журнала, правка сведений атомарна, заявки — записью админа

**Spec 007, FR-028, D-04 (3 окт 2026; найдено прогоном обычных сценариев с v2
по умолчанию).** Три дефекта одного класса — клиент верил не журналу:
desktop применял к группе v2 нотис и список v1-шарда (поддельный нотис менял
права, описание и роль участника), Android по v1-нотису `removed` снимал группу;
правка названия и описания с одного экрана давала две записи `set_info`,
собранные по снимку «до», и вторая откатывала первую; заявка на вступление по
ссылке «с одобрением» отклонялась движком у самого заявителя.

1. **Источник сведений.** Название, описание, фото, состав, роли и права группы
   с адресом `v2g:<hex>` клиент берёт ТОЛЬКО из журнала группы, проверенного
   движком. Кадр `{group}` инбокса v1 и ответ `group.list`/`group.info` о такой
   группе не применяются и группу не снимают.
2. **Правка сведений.** Запись `set_info` несёт все три поля (`name`, `about`,
   `avatar_file_id`). Клиент передаёт только изменяемые, остальные берутся из
   журнала в той же критической секции, где запись строится и применяется
   (очередь контроллера в web, мьютекс движка в ядре). Запись без изменений не
   создаётся. Описание длиннее 255 символов клиент отклоняет сам (схема меряет
   поле байтами — 1024; предел в символах, как у v1, держит клиент).
3. **Заявки.** Вступление по ссылке с `requires_approval` — запрос `group.join`
   с записью `JoinByInvite`, которую заявитель локально НЕ применяет (ответ
   сервера — `pending`). Админ с правом приглашать читает `group.request.list`
   и решает `group.request.decide`: одобрение несёт запись `AddMember` (её
   строит движок — `group_request_decide`), после неё — новая эпоха; отказ
   журнал не меняет. О новой заявке и об отказе сервер сообщает админам
   уведомлением о группе без смены версии — клиент перечитывает список заявок.

Реализации: движок `client.rs` (`group_request_decide`, `group_join`), сервер
`messenger/src/v2_groups.rs` (`notify_invite_admins`); web `v2/controller.ts`
(`setGroupInfo`, `listJoinRequests`, `decideJoinRequest`), `groups.ts`; ядро
`v2_session.cpp` (`changeGroup` с `set_info_patch`, `listJoinRequests`,
`decideJoinRequest`); tdesktop `ApplyGroupInfo`, обработчик `onGroupNotice`,
`V2SetInfo`, `ListJoinRequests`/`DecideJoinRequest`; Android JNI `v2SetInfo`,
`onGroupNotice`, `nativeGroupRequests`/`nativeGroupRequestDecide`. Тесты: движок
`client_flow.rs` (`join_request_is_approved_by_add_member`), сторож
`conformance.test.ts` (GROUP-3), сценарии web `web2-groups`
(`e2e_protocol_groups.mjs`: заявка, отказ, одобрение), `group_admin`
(переименование админом), desktop `verify_conformance_group.sh` (п. 3: v1-нотис
к группе v2 не применён), `verify_protocol_v2_invites.sh`, `verify_group_manage.sh`.

## E6-1. Клиент работоспособен без соединения v1

**Spec 007, FR-056 (этап E6), T134 (4 окт 2026).** Сервер с `PARVANE_V1_MODE=disabled`
отвечает на JSON-соединение v1 кадром `upgrade_required` и закрывает его. Клиент с
включённым v2 при этом обязан работать полностью:

- всё, что не переписка, идёт методами v2 — вход и регистрация (канал PRE, до
  `Auth`: `server.describe`, `identity.session.issue`, `identity.account.*`),
  профили и поиск, 2FA и смена пароля (со свежим `identity.session.reauth`),
  линковка, превью и тайлы карты, ICE, удаление файла. Web делает это мостом:
  прежний запрос (subject + JSON) → метод v2 → ответ прежнего вида (список
  subject'ов — `bridged` в `sync-rules.json`); desktop с T038 (spec 029, 20 окт 2026)
  зовёт методы v2 напрямую типизированным API `parvane-core/src/v2_account.cpp`
  (список методов — `desktopMethods`), моста и транспорта v1 в desktop нет;
- то, что обслуживает v1-шифрование и каталог v1-устройств (`prefersV1`), идёт по
  v1, пока оно живо; без него список и отзыв устройств — методами v2
  (устройство журнала v2 отзывается записью журнала после проверки пароля);
- свой либо открытый блоб (аватар, фото группы, блоб линковки) грузится и
  скачивается методами `cloud.blob.*`; вложения чатов — по секрету capability (CAP-1);
- кадры инбокса v1, которые сервер перекладывает в инбокс v2 (записи `LegacyV1`:
  история при первом синке и живые кадры), клиент без соединения v1 подаёт тем же
  обработчикам инбокса — история v1 остаётся читаемой (FR-053);
- присутствие («в сети») публикуется и эфемерным каналом v2;
- отсутствие v1 — не ошибка: диалога «обновите приложение» нет, цикла
  переподключений v1 нет, запросы переписки v1 (`msg.sync.request`, `group.list`,
  `call.history.request`, публикация прекеев) не шлются;
- текста ошибок в протоколе v2 нет: формулировки для экранов входа клиент
  подставляет сам по запросу и коду.

Сценарии: web — вся матрица (с T110 web без v1 целиком; пара `v1-off` удалена), desktop —
все `desktop/verify_*.sh` (со spec 029 desktop без v1, с T038 — без моста; `verify_protocol_v2_v1off.sh` удалён), android — блок disabled в
`android/tgx_protocol_v2_flow.sh desktop2-android2` (мост в `android/jni`
подключён 4 окт 2026: X отмечает отключение v1, диалога нет, сессия остаётся).
Переписка Android при отключённом v1 отдельным сценарием ещё не покрыта.

## GROUP-4. Группа v1 переводится в v2, чат остаётся прежним

**Spec 007, T180 (4 окт 2026), SC-002.** Группы, созданные по v1 (шард `group.*`, Megolm), после
отключения v1 перестали бы работать. Перевод:

- делает клиент **владельца**, когда все участники на v2 и ни у кого (включая его самого) нет
  v1-устройств из подписанного списка LEGACY-1 — иначе чьё-то устройство перестало бы получать
  сообщения группы; до этого группа живёт по v1;
- создаётся группа v2 с тем же составом; запись генезиса `Create` несёт `migrated_from` —
  прежний `group_id`. Поле входит в запись, из которой выводится идентификатор группы, и позже
  не меняется. **Права по умолчанию идут в ту же запись генезиса**: отдельная `set_permissions`
  потребовала бы новой эпохи (не чаще раза в 10 с), и первые сообщения после перевода не уходили бы;
- описание и фото (`set_info`) и админы (`set_role`) переносятся следом; сбой такой записи перевод
  не отменяет;
- клиент участника, получив группу v2 с `migratedFrom`, **продолжает прежний чат**: идентификатор
  чата в UI считается от прежнего `group_id`, история v1 остаётся в нём, всё новое (отправка,
  сведения, «печатает») идёт по адресу `v2g:`; второй чат не заводится;
- сведения и нотисы v1-шарда о переведённой группе (включая `removed`/`deleted`) больше **не
  применяются** — иначе прежний чат снялся бы вместе с историей;
- связь «прежний id → группа v2» поднимается из кэша сведений групп v2 **до** воспроизведения
  локальной истории — в том числе на сервере без v1.

Тесты: движок — `create_records_migrated_from` (`backend/protocol/src/group.rs`); desktop —
`desktop/verify_protocol_v2_group_migrate.sh` (три клиента: перенос, описание, переписка по v2,
таблица сообщений v1 не растёт, работа после `PARVANE_V1_MODE=disabled`); web —
`scripts/run_protocol_mixed_e2e.sh group-migrate` (пара удалена с T110 — переводить нечего; один чат в списке, история обеих эпох, после
перевода `msg.chat.send` по v1 не уходит); сторож — `conformance.test.ts` (GROUP-4).
Android — не сделано (T184).

## OP-SIG. Каноничная подпись операций

**Spec 007, D-10 (замена SEND-1 для v2).** Любая подписанная операция
(`SignedOp`: сообщение, правка, удаление, реакция, закреп, запись журнала
устройств/группы/состояния, сигнал звонка) подписывается Ed25519 над
`"parvane/v2/op" ‖ u8(len) ‖ domain ‖ u8(len) ‖ op_type ‖ body`, где `body` —
байты `OpHeader`+полезной нагрузки как пришли по проводу (без
пересериализации). Контексты подписи без общих префиксов; подпись операции
одного вида не проходит проверку как операция другого вида или домена.
Векторы: `proto/parvane/vectors/sign/ops.json` (движок —
`backend/protocol/tests/vectors_sign.rs`).

Подписывает и проверяет операции только движок; клиенты прогоняют набор `sign/ops`
через свою обвязку: web — `protocol.vectors.test.ts` (WASM), desktop —
`desktop/parvane-core/tests/protocol_vectors_tests.cpp` (ctest `protocol_vectors`, C ABI
`pv_run_conformance_vectors`), android — `ProtocolV2SeamTest.kt`
(`conformanceVectorsPassThroughCAbi`).

## PROTO-1. Протокол разбирает только движок

**Spec 007, принцип III конституции 2.0.0.** Кадры, тела запросов, конверты и
виды содержимого v2 разбираются и собираются только общим движком
`parvane-protocol` (web — WASM, desktop/android — C ABI); собственного
разбора protobuf/кадров в клиентах нет. Неизвестный вид содержимого или
критичное поле → нативная заглушка «сообщение не поддерживается», следующее
сообщение доставляется (`Disposition::Stub`); неизвестная запись журнала —
пропуск. Сторож в web — `conformance.test.ts` (PROTO-1: движок подключается
только в `v2/engine.ts`, в `v2/*.ts` нет varint/DataView и `JSON.parse` не
движковых ответов). Векторы кадров — `proto/parvane/vectors/codec/frames.json`.

## Векторы v2 — указатель (T088)

Все правила, которые переносятся на протокол v2, проверяются по векторам
`proto/parvane/vectors/**` (индекс — `proto/parvane/vectors/conformance/README.md`):
кадры и лимиты — `codec/`; подписи — `sign/`; журналы устройств (KEY-1 v2,
LINK-1) — `device_log/`; журнал группы (GROUP-1, GROUP-2 права) —
`group_log/`; конверты (SEAL-1, GSEAL-1) — `seal/`; личное состояние
(STATE-1) — `state/`; ссылки-приглашения — `invite/`; v1-история — `legacy_v1/`;
права по типу содержимого — `content_guard/`; виды содержимого (CONTENT-1) —
`content/`; режим «усиленная приватность» (L2-1) — `l2/`.

## Обязательный сценарий: устройство отсутствовало

Все e2e гоняются на чистом стеке, где оба клиента онлайн и устройства уже в
каталоге. Случай «отправили, пока второго устройства не было» не проверялся
никогда — именно он и ломался. Сценарий обязан быть в каждом клиенте:

- desktop: `desktop/verify_offline_device.sh`
- web: `scripts/run_web_offline_device_e2e.sh`
- android: `android/tgx_conformance_flow.sh`, шаг 1 (X остановлен, bob-desktop
  шлёт три сообщения, X запущен → все три показаны, курсор в `cursors.json`
  сдвинут только за применённое; 27 сен 2026)

## DOMAIN-1. Домены протокола v2: планировщик `parvane.planner.v1`

**Spec 010 (8 окт 2026), поверх каркаса доменов spec 007 (R11).** Данные
планировщика лежат в контейнере домена `parvane.planner.v1` (шард `domains`):
журнал зашифрованных операций с `seq`, снимки, ключ эпохи. Один контейнер на
пользователя, владелец — пользователь, грантов нет (задел).

1. **Ключ контейнера — своим устройствам.** Устройство, у которого есть ключ,
   шлёт его своим устройствам видом содержимого E2E `container_key`
   (`ContainerKeyShare`): при создании контейнера, новому устройству из
   журнала устройств (вместе с ключами групп, LINK-1 п. 9) и после смены
   эпохи. Ключ принимается только от своего аккаунта (владельца); голова
   журнала грантов раздающего обязана совпасть с нашей историей, более новая —
   сначала догнать `domain.grant.list`.
2. **Экспорт линковки** несёт ключи контейнера (поле `planner`:
   `{domain, id(hex), keys: [[эпоха, base64]]}`) — раздел открывается сразу
   после привязки; клиент, не знающий поля, его игнорирует.
3. **Отзыв устройства** (REVOKE-1) поднимает эпоху контейнера записью
   журнала грантов `rotate` (`domain.key.rotate`, подпись админа); новый ключ
   — оставшимся своим устройствам; отозванное новых операций не читает.
4. **Чужой домен.** Клиент, не реализующий домен (desktop, android),
   принимает `container_key` и операции незнакомого домена без ошибок и без
   влияния на остальную синхронизацию (движок хранит ключ, UI не трогает).
5. **Сведение** — в движке (`domain/planner.rs`): «последняя правка
   побеждает» по полям объекта, надгробия, метки `(lamport, device_id)` +
   байты изменения; снимок каждые 200 операций; потолки каркаса (операция
   256 КБ, снимок 1 МБ).

Реализации: движок `client_planner.rs`, `domain/planner.rs`,
`domain/planner_json.rs`; шард `domains` (`key.rotate`, `container.list`);
web `v2/planner.ts`, `controller.ts`, `provider.ts`, `plannerSync.ts`,
`plannerStore.ts`. Тесты: движок `planner_domain.rs`, `client_flow.rs`
(ключ своим устройствам, смена эпохи, чужой ключ игнорируется), шард
`tests.rs key_rotate_and_container_list`; web `plannerSync.test.ts`, сторож
`conformance.test.ts`, сценарий `scripts/e2e_web_planner_sync.mjs`.

## TASK-1. Задание в чат (`task_offer` / `task_response`)

**Spec 011 (8 окт 2026).** Задание — вложение сообщения v2 по образцу
геолокации и опроса: `Content.task_offer` (поле 20; название, описание, шаги,
дата, время, оценка в минутах, дедлайн и `text` — текстовое представление) и
`Content.task_response` (поле 21; ссылка `offer` на карточку, решение
`TASK_DECISION_ACCEPTED|DECLINED`, `text`). Оба — обычные сообщения класса
`message` (вектора `content/kinds.json`: `task-offer`, `task-response-*`),
трекаются доставкой/прочтением как текст.

1. **Клиент с планировщиком (web)** рисует карточку с полями и кнопками
   «Принять»/«Отклонить» у получателя, «В мой план» у автора; решения
   участников показываются на карточке; решение — отдельным сообщением
   `task_response` со ссылкой на карточку (в «Избранном» ответ не шлётся).
2. **Принятие создаёт задачу один раз на аккаунт**: у задачи планировщика
   поле `source {chat, op_id}`; второе устройство того же аккаунта, увидев
   задачу с тем же `source` в контейнере, задачи не создаёт.
3. **Клиент без планировщика (desktop, android)** показывает поле `text`
   обоих видов как обычный текст — не заглушку «не поддерживается» — и
   продолжает синхронизацию (следующие сообщения доставляются). Принять он
   не может; `text` формирует отправитель.
4. Карточка и ответы восстанавливаются из кэша истории (в отличие от
   голосов опросов): обе строки проходят обычным конвейером сообщений.

Реализации: движок `msg.rs` (`is_trackable`), вектора
`backend/protocol/tests/vectors_content.rs`; web `v2/contentMap.ts`,
`taskOffers.ts`, `sync.ts` (`handleTaskOfferContent`), `store.ts`,
`messages.ts` (`parvaneSendTaskOffer`, `parvaneRespondTaskOffer`),
`components/middle/message/TaskOffer.tsx`, `TaskOfferModal.tsx`; desktop
`parvane-core/src/v2_content.cpp` (`v2Kind`, `fromV2` → `kind: text`);
android `ParvaneStore.kt` (`contentFrom` → `MessageText`). Тесты: web
`taskOffers.test.ts`, `protocol.vectors.test.ts`, сторож `conformance.test.ts`,
сценарий `scripts/e2e_web_task_offer.mjs`; desktop `tests/v2_tests.cpp`;
android `ProtocolV2SeamTest.kt`.

## DOMAIN-2. Облако: домен `cloud.v1` (spec 016)

Раздел «Облако» — контейнеры домена `cloud.v1` в шарде `domains`: личный диск пользователя и совместные папки.
Открытый текст операции журнала — `CloudBatch` (до 500 `CloudOp`), снимка — `CloudSnapshot`; содержимое файлов —
PVB2-блобы (BLOB-1) в отдельном bucket шарда `cloud` со своей квотой и пределом файла.

1. **Сведение дерева — только по итоговым регистрам узла**: создание (вид; при двух созданиях одного id — меньшая
   метка), «родитель + имя», «содержимое», «корзина» — LWW по метке `(lamport, device_id)`, при равных — по
   содержимому; `purge` необратим и стирает узел с потомками. Узел существует только после создания. Видимое
   дерево: узел, чей родитель неизвестен или не папка, — в корне; в цикле в корне показывается узел с наибольшей
   меткой перемещения. Совпавшие имена соседей: старший по созданию хранит имя, остальные получают номер.
   Снимку достаточно итоговых регистров; надгробия `purge` живут в снимке 90 дней.
2. **Метки** операции обязаны нести устройство автора; операция автора без права записи в её эпохе отвергается
   клиентами (права читателя соблюдаются не только сервером).
3. **Ключи эпох** (`container_key`, домен `cloud.v1`): своим устройствам — от своего аккаунта, участникам — от
   админа контейнера; ключ от не-админа не принимается. Ключи всех контейнеров идут в экспорт линковки (поле
   `cloud`, JSON-массив `{domain, id(hex), keys: [[epoch, base64]]}`) и в копию ключей аккаунта (то же поле).
4. **Доступ**: читатель — `READ`, редактор — `WRITE`, владелец — `ADMIN`. Понижение редактора до читателя — грант и
   смена эпохи. Удаление участника — `domain.grant.revoke` (новая эпоха). Выход участника — запись `leave`
   (`domain.grant.leave`), подписанная самим участником, эпоха прежняя; владелец, увидев её, меняет эпоху. Отзыв
   своего устройства — смена эпохи во всех контейнерах, где пользователь админ.
5. **Контейнеры аккаунта** объявляются в журнале личного состояния (`cloud_container_set`: личный диск, своя
   совместная папка, чужая папка с ответом на приглашение); личный диск один (при двух — меньший id).
6. **Блоб стёртого файла** стирает устройство владельца блоба (`CloudBlobRef.uploader`), увидев `purge`.
7. **Файл между облаком и чатом** — копия блоба на сервере (`cloud.blob.copy`) со своим секретом доступа; ссылку
   на один блоб облако и сообщение не делят.
8. Клиент без раздела игнорирует домен: ключи принимает и хранит движок, ошибок нет.

Пределы: 8 000 узлов на контейнер, снимок ≤ 3 МиБ, порог снимка 200 операций.

## CLOUD-1. Приглашение в совместную папку (`cloud_invite`)

`Content.cloud_invite = 22` — видимое сообщение личного чата: ссылка на контейнер, название папки, роль (1 —
читатель, 2 — редактор), `text` (≤ 600) — представление для клиентов без раздела «Облако». Ключ контейнера идёт
отдельным сообщением `container_key`. Клиент с разделом показывает приглашение в «Доступные мне» и принимает или
отклоняет его (отказ — запись `leave`); клиент без раздела показывает `text` обычным текстом и не падает.

## CLOUD-2. Ссылки облака для людей без аккаунта (spec 022)

Ссылка `https://<сервер>/s/<link_id>#k=<ключ>` — снимок файла либо папки облака: серверные копии блобов в квоте
владельца и список, зашифрованный ключом ссылки. Ключ живёт только во фрагменте адреса и серверу не передаётся.

1. **Создаёт и ведёт ссылки только web**: методы владельца `cloud.link.create/add/publish/list/revoke/extend`
   (ID-канал). Desktop и android этих методов не вызывают и ни раздела «Облако», ни ссылок не показывают.
2. **Получатель — без аккаунта**: публичная страница web ходит анонимным каналом (`cloud.link.get`,
   `cloud.link.download`) и шлёт серверу только `link_id` и `file_id` копии. Прочие методы анонимному каналу закрыты.
3. **Идентификатор ссылки** — 16 случайных байт, base64url без `=` (22 знака), выдаёт сервер; срок — 0 (без срока),
   1, 7 либо 30 дней. Отсутствующая, отозванная и готовящаяся ссылки для получателя неразличимы (`NOT_FOUND`);
   истёкшая отдаёт `expired` без списка, файл — `EXPIRED`.
4. **Копия ссылки — не обычный блоб**: `cloud.blob.download`, `cloud.blob.download_cap`, `cloud.blob.copy` и
   `cloud.blob.delete` её не видят (`NOT_FOUND`); она читается только через действующую ссылку и удаляется только
   отзывом либо сборщиком. Клиент не должен пытаться стереть её как блоб стёртого файла (DOMAIN-2, п. 6).
5. **Занятое место**: копии входят в `used` bucket'а облака; отдельно — поле `UsageResponse.links_bytes = 2`.
   Клиент, не знающий поля, его пропускает.
6. Клиент без раздела новых методов не касается: общий движок и реестр методов от них не ломаются, ошибок нет.

Сервер: `backend/shards/cloud/src/v2/links.rs` (тесты там же и `backend/tests/integration/tests/v2_links_live.rs`),
схема `proto/parvane/cloud/v1/cloud.proto` (`service LinkService`). Контракт — `specs/022-public-links/contracts/links.md`.


## ARTICLE-1. Статья (`article`)

`Content.article = 23` — видимое сообщение: `title` (≤ 200), `markdown` — текст заметки «Знаний» целиком (≤ 65 536,
без свойств заметки), `text` (≤ 600) — название и начало текста для клиентов без окна чтения, `media` (≤ 32, с 15 окт
2026) — файлы, встроенные в текст (`![[имя]]`): вложения по секрету доступа (CAP-1), `Media.name` — имя в тексте;
страж содержимого применяется к каждому, как к обычному вложению. Замена «Статьи» Telegram (там — редактор статей; у нас статья — это заметка). Web показывает карточку с
началом текста и окно чтения с «Сохранить в заметки»; клиент без окна чтения показывает `text` обычным текстом и
не падает.

## REPORT-1. Жалоба админам группы (`mod_report`)

**Spec 024 (17 окт 2026), правило открыто: web — сделано, desktop — со spec 029, android — нет.**
`Content.mod_report = 24` — видимое личное сообщение каждому админу группы с правом удалять сообщения или банить:
`group` (группа), `messages` (≤ 20: `op_id`, автор, текст, время), `reason` — код причины (`spam`, `violence`,
`porn`, `child`, `copyright`, `illegal`, `personal`, `fake`, `other`), `comment` (≤ 1024), `text` (≤ 600) —
представление для клиентов без модерации. Web показывает карточку с «Удалить сообщения» (мутация удаления в группе
от админа) и «Заблокировать в группе» (запись `Ban` журнала группы). Клиент без модерации обязан показать `text`
обычным текстом и не падать; до реализации android показывает сообщение как неподдерживаемое (CONTENT-1).
Жалоба администратору сервера — не содержимое переписки: метод `identity.report.submit`, шифртекст под ключом
`ServerDescribeResponse.report_public_key` (HPKE, `info = "parvane/v2/report\0" ‖ адрес автора`), клиентам без
этой функции делать ничего не нужно.

Desktop (spec 029): ядро `v2_content.cpp` (`mod_report` ↔ v2), `messenger.h` (`contentText`),
`v2_session_account.cpp` (`submitReport`); tdesktop `parvane_client.cpp` (`ReportMessages` из штатного окна
`api_report.cpp`, карточка админа `CardMarkup` → `HandleCardButton` `pv:moddel`/`pv:modban`); тест
`tests/v2_tests.cpp` («mod_report туда и обратно», «карточка mod_report показывается текстом»).

## RENAME-1. Смена ника

**Spec 026 (17 окт 2026), правило открыто: web — сделано, desktop — со spec 029, android — нет.**
Личность — корень; адрес — её имя. Смена ника — запись `Rename` (подпись корнем) в журнале устройств прежнего
адреса: журнал закрыт, его ключи устройств больше не действуют (прошлые подписи проверяемы по версии журнала), а
личность продолжается журналом нового адреса, чей генезис — тот же корень с `renamed_from` = прежний адрес и
хешем, указанным в `Rename.new_genesis_hash`. Клиент обязан:

1. **Собеседник.** Журнал собеседника закрыт `Rename` — дочитать журнал нового адреса; если он продолжение
   (тот же корень, взаимные ссылки) — перенести на новый адрес всё о собеседнике (сессии, ключ доступа,
   «липкость», режим L2, учёт раздачи ключей групп) и показать чат прежним, с новым ником. Это НЕ смена ключа:
   предупреждения KEY-1 нет. Журналы не связаны — ничего не переносить.
2. **Свой прежний адрес.** Устройство, сменившее ник, помнит прежний адрес: конверты, запечатанные на него,
   открываются; свои подписи в журналах групп и контейнеров под прежним адресом — свои; записи личного состояния,
   запечатанные под прежним адресом, читаются.
3. **Своё другое устройство** (журнал своего адреса закрыт `Rename`): войти в журнал нового адреса своим
   сертификатом под новым адресом (подпись SSK) и перейти на новый адрес.
4. **Группы.** Участник переносится записью `GroupChange.rename_member = 19` (`RenameMember`: доказательство —
   запись `Rename`; подписант — новый адрес, `GroupStateChange.signer_address`); корень записи обязан совпасть с
   корнем журнала прежнего адреса. Записи после смены ника несут `signer_address`: ключ устройства есть в двух
   журналах.
5. **Контейнеры доменов** (`План`, облако): права, выданные прежнему адресу, — права нового (`Author.aliases`).

Сервер: `identity.account.rename` (свежее подтверждение паролем) — обе цепочки проверяются движком; прежний ник
30 дней ведёт на новый (вход — `SessionIssueResponse.address`, доставка, `DevicesOfResponse.address`) и занят;
токены прежнего адреса недействительны; шарды переносят свои строки (`v2.internal.rename.<шард>`). Клиенту без
этой функции до реализации: прежний адрес собеседника перестаёт принимать сообщения через 30 дней.

Desktop (spec 029): ядро `v2_session_account.cpp` (`renameAccount`, `followPeerRenameLocked` → событие
`peerRenamed`, `followOwnRename`, `renameGroupsPending`); tdesktop `parvane_client.cpp` (`RenameAccount`,
`MoveAccountLocal`, `NoteRename`/`LatestAddress`), `parvane_account_ui.cpp` (`ShowRenameBox`); живой тест
`tests/v2_session_tests.cpp` (spec 026: отказ при неверном пароле, смена ника, вход новым ником, `peerRenamed` у
собеседника). Пп. 3 и 4 тестом не покрыты.

## DELETE-1. Удаление аккаунта

**Spec 027 (17 окт 2026), правило открыто: web — сделано, desktop — со spec 029, android — нет.**
`identity.account.delete` (свежее подтверждение паролем) ставит аккаунт на удаление: все токены сразу
недействительны, сессии закрываются, для других аккаунт исчезает; через 7 дней identity и шарды стирают его строки
(`RenameNotice.purge = 4` на `v2.internal.rename.<шард>`), ник свободен. Клиент обязан:

1. **Вход.** Ответ `SessionIssueResponse` с `deletion_at_ms = 8` и без токена — не ошибка пароля: показать дату и
   предложить восстановить аккаунт; восстановление — тот же вход с `SessionIssueRequest.cancel_deletion = 9`.
   Сохранённый пароль сам удаление не отменяет (флаг ставит только человек).
2. **Собеседник.** Синк журнала устройств с `deleted = 4` (`DeviceLogSync(Anon)Response`) — аккаунт удалён либо
   ждёт удаления: показать «Удалённый аккаунт», не повторять отправку. Новый владелец ника — новый журнал (смена
   корня, KEY-1).

Desktop (spec 029): ядро `v2_session_account.cpp` (`deleteAccount`, `isDeletedLog` → событие `peerDeleted`),
`v2_bridge.cpp` (`deletion_at_ms`, `cancel_deletion`); tdesktop `parvane_client.cpp` (`Issue` с `cancelDeletion`,
`DeleteAccount`, `MarkPeerDeleted`), `intro/intro_parvane.cpp` (дата и «Восстановить» на экране пароля),
`parvane_account_ui.cpp` (`ShowDeleteAccountBox`); живой тест `tests/v2_session_tests.cpp` (spec 027: удаление,
вход в период ожидания без токена, вход с отменой). П. 2 тестом не покрыт.

## ORDER-1. Порядок сообщений в ленте

**Spec 012 (9 окт 2026): web — сделано, desktop — со spec 029 (порядок прихода), android — нет.**
Время сообщения в протоколе v2 — время ОТПРАВИТЕЛЯ по его часам; общего времени
нет (серверное округлено до минуты, и клиент его не читает). Клиент, который
упорядочивает ленту по этому времени, ставит ответ собеседника с отстающими
часами ВЫШЕ сообщения, на которое тот отвечает.

1. **Живое сообщение** — своя отправка либо входящее, чьё время отличается от
   «сейчас» не больше чем на 300 с, — встаёт после всего, что уже есть в ленте
   чата на этом устройстве. Входящие приходят в порядке очереди сервера, поэтому
   порядок совпадает у получателя и на его втором устройстве.
2. **Место сохраняется** вместе со строкой истории (локальное поле `order`) и при
   восстановлении берётся оттуда; порядок после перезапуска тот же. Для своего
   сообщения время и место — момент нажатия, а не конец отправки.
3. **Старое сообщение** (догон после долгого офлайна, перенос истории при
   линковке) встаёт по времени отправителя; строки без сохранённого места
   упорядочены по времени.

Показанное время сообщения не меняется — правило только о порядке. Поле `order`
на сервер не уходит. Реализация web: `store.ts` (`allocateMessageId`,
`compareStoredOrder`), `sync.ts`, `messages.ts`; тест `store.test.ts`, сценарий
`scripts/e2e_web_saved_messages.mjs`.

Desktop (spec 029, 18 окт 2026): id сообщения — счётчик `g_nextMsgId` по порядку
прихода (лента tdesktop упорядочена по id), время отправителя на порядок не
влияет; место сохраняет журнал истории — `ReplayHistory` воспроизводит строки в
порядке записи. Отличие от п. 3: догон и перенос истории встают тоже по порядку
прихода (инбокс v2 отдаёт их в порядке очереди сервера). Сторож — блок ORDER-1 в
`conformance.test.ts`.

## RECOVER-2. Новое устройство по ключу восстановления — без других устройств

**Spec 015 (10 окт 2026), правило открыто: web — сделано, desktop — со spec 029, android — нет.**
По RECOVER-1 ключ восстановления означал «все устройства потеряны»: корень назначал
новый ключ подписи устройств, прежние устройства отзывались, история и ключ личного
состояния не возвращались. Привязка с другого устройства требовала это устройство в
сети и терялась при обрыве связи (прод, 9 окт 2026: история перенесена, а записи
устройства в журнале нет — оно не отправляет сообщения и не видит планировщик).

1. **Копия ключей аккаунта** лежит на сервере рядом с копией корня
   (`RootBackupSetRequest.key_bundle`, ≤ 256 КиБ; сервер сбрасывает её при смене
   копии корня). Формат: `"PVKB"` ‖ версия (1) ‖ nonce (12) ‖ AES-256-GCM(JSON),
   ключ = HKDF-SHA256(ikm = ключ восстановления без «-» в верхнем регистре,
   O→0, I/L→1; salt = `parvane/v2/key-bundle`; info = адрес), AAD = `"PVKB"` ‖
   версия ‖ адрес. JSON: `grant` (материал гранта движка `linkGrantMaterial`,
   base64), `planner` (ключи контейнера), `history` (`fileId`, `fileKey`,
   `fileNonce`, `at`, `mark`, `size` — блоб в cloud со строками истории в формате
   экспорта линковки, LINK-1 п. 8).
2. **Ключ копии** устройство получает, пока ключ восстановления в руках (создание
   и сброс личности, ввод ключа), хранит у себя и передаёт привязанным устройствам
   полем `bk` материала гранта. Сам ключ восстановления устройство не хранит.
3. **Копию пишет** устройство, держащее ключ копии и ключ подписи устройств: после
   запуска, раз в минуту при изменении содержимого, при появлении нового своего
   устройства. Снимок истории крупнее 512 КиБ — не чаще раза в 30 минут.
4. **Вход по ключу**: ключ проверяется копией корня; копия ключей открывается,
   журнал устройств в материале заменяется свежим ответом `identity.device.log_sync`
   (подлинность — ключ подписи устройств из копии обязан совпасть с журналом),
   устройство вступает в журнал тем же запросом, что при привязке. Прежние
   устройства остаются. Нет копии ключей (аккаунт создан раньше) — путь RECOVER-1.
5. **Привязка переживает обрыв** (и по гранту, и по ключу): материал, а после
   построения запроса — состояние движка вместе с запросом лежат в хранилище
   устройства до ответа сервера; повтор — тем же запросом (новые ключи устройства не
   выпускаются). Отказ сервера на повторе проверяется запросом
   `identity.device.publish_certificate` без записи журнала: принят — запись уже
   была внесена.
6. **Telegram** (сервер с ботом и привязанным Telegram): действующее устройство
   шлёт ключ владельцу `identity.recovery.tg_send` (сервер сверяет ключ с копией
   корня); новое устройство просит ключ `identity.recovery.tg_request` и забирает
   ответ владельца `identity.recovery.tg_poll`. Бот — `identity.telegram.pull` /
   `identity.telegram.reply` с общим секретом. **Ключ при этом виден серверу и
   Telegram открытым текстом** (решение пользователя); в базу и журналы сервера и
   бота он не пишется — только память процесса identity (сообщение боту 10 мин,
   ответ владельца 15 мин).

Реализация web: `v2/keyBundle.ts`, `v2/controller.ts`, `provider.ts`, экран
`SettingsActiveSessions.tsx`; тесты `v2/keyBundle.test.ts`, `v2Link.test.ts`,
сторож `conformance.test.ts`; сценарии `scripts/e2e_web_telegram_recovery.mjs`,
`scripts/e2e_web_telegram_bot.mjs`. Сервер: `shards/identity/src/recovery_tg.rs`,
`v2.rs`; бот `infra/telegram-bot/parvane_tg_bot.py`.

Реализация desktop (spec 029): ядро `keybundle.cpp` (PVKB), `v2_session_account.cpp`
(`refreshKeyBundleLocked`, `joinWithRecoveryKey`, `sendKeyToTelegram`,
`requestTelegramKey`, `pollTelegramKey`); tdesktop `parvane_client.cpp`
(`StartTelegramRecovery`, `PollTelegramRecovery`, `RecoverWithKey`),
`parvane_account_ui.cpp`; тесты `tests/webcompat_tests.cpp` (`keyBundle`: копия web
открывается, ключ из текста — как web), живой `tests/v2_session_tests.cpp` (spec 015:
копия на сервере, вход по ключу, прежнее устройство осталось).

## PUBLIC-1. Публичные группы и каналы (spec 023, 15 окт 2026)

Решение пользователя: имя и секрет публичной группы серверу знать можно. Публичность — запись журнала группы
`SetPublic` (`GroupChange.set_public = 17`): имя (5–32, `[a-z][a-z0-9_]`, общее пространство с никами пользователей),
открытый секрет `S` (32 байта), настройки админа «Читать без вступления» и «История для новых участников». Из `S`
выводятся ключ публичной ссылки (вступление — `JoinByInvite`, эпоха при этом не устаревает) и ключ комплекта эпохи
`NewEpoch.public_bundle` (ключ конверта ‖ ключ отправки). В публичной группе конверт несёт экспорт Megolm-сеанса автора
(`GroupEnvelopeInner.public_session`). Каталог, поиск, открытие по имени и история — методы `group.public.*`.

1. Клиент с поддержкой показывает тип «Публичная/Частная», имя и честное предупреждение: переписку публичной группы
   может прочитать любой вступивший и технически сервер.
2. Клиент без поддержки обязан пропускать такую группу без падения (android — ОТКРЫТО, сборка не обновлялась).

Desktop (spec 029) поддерживает: ядро `v2_session_groups.cpp` (`checkPublicName`, `searchPublic`, `resolvePublic`,
`setGroupPublic`, `joinPublic`, `publicHistory`), tdesktop `parvane_client.cpp` (`SetGroupPublic`,
`SearchPublicGroups`, `LoadPublicPreview`, `JoinPublicGroup`); живой тест `tests/v2_session_tests.cpp` (spec 023:
публичность, имя, поиск, вступление по открытому секрету, история для нового участника).
