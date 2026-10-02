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

Legacy-офферы v1 (без `commitment`, 6-значный код от одного ключа) не
обслуживаются старым устройством. Код сверки не пишется в логи release-сборок.

Кросс-клиентские векторы (`vectors` в `sync-rules.json`): `new = 65×0x00`,
`old = 0x04 || 64×0x01` → `commitment(new) = mM5C3u9R1AJp1UL1MUvvLHRo1AGtXYUWi/q0wBCPdfc=`,
`SAS = 5659 7031 8371`.

Реализации: web `api/parvane/linking.ts` (`linkCommitment`, `sasCodeV2`) +
`provider.ts` (`startHistoryLinkOffer`, `describeLinkOffer`, `parvaneGrantLink`) +
`e2e.ts` (`exportLinkStateJson`, `signLinkTransfer`, `importLinkedHistory`);
desktop `parvane-core` `linking.cpp`/`e2e.cpp` + `parvane_client.cpp`
(`StartHistoryLinkOffer`, `PollLinkOffersOnce`, `GrantLink`); android
`jni/parvane_jni.cpp` (`startLinkOffer`, `pollLinkGrantOnce`). Сервер:
`identity` (`store_link_offer`, `store_link_challenge`), `messenger`
(`authenticated_transfer_keys`). Тесты: web `linking.test.ts` +
`conformance.test.ts` (`LINK-1`), desktop `tests/linking_tests.cpp` +
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
