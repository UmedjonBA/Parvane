# Conformance — правила, обязательные для ВСЕХ клиентов

Клиентов три (web, desktop, android), и каждый реализует протокол Parvane
самостоятельно. Из-за этого починка уезжает в один клиент и не доезжает до
остальных. Реальный случай: коммит `23ce150d` починил продвижение курсора синка
в вебе (сентябрь 2026), а десктоп остался с той же дырой и терял сообщения ещё
несколько недель, пока пользователь не сообщил «чат отстаёт и не догоняет».

Здесь лежат правила, которые обязан соблюдать любой клиент, с идентификаторами.
Правило считается закрытым, только когда на него есть тест В КАЖДОМ клиенте.
`sync-rules.json` — машиночитаемая версия для тестов.

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
`android/tgx_folders_preview_flow.sh`, шаг 3 (маркер «тайл 16/x/y через preview»).

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

## Обязательный сценарий: устройство отсутствовало

Все e2e гоняются на чистом стеке, где оба клиента онлайн и устройства уже в
каталоге. Случай «отправили, пока второго устройства не было» не проверялся
никогда — именно он и ломался. Сценарий обязан быть в каждом клиенте:

- desktop: `desktop/verify_offline_device.sh`
- web: `scripts/run_web_offline_device_e2e.sh`
- android: `android/tgx_conformance_flow.sh`, шаг 1 (X остановлен, bob-desktop
  шлёт три сообщения, X запущен → все три показаны, курсор в `cursors.json`
  сдвинут только за применённое; 27 сен 2026)
