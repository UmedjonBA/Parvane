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
v1-код в web не вернулся. Desktop и Android прошли тот же переход позже (spec 029
и spec 031, абзацы ниже). Поле `clients.web` в `sync-rules.json` у таких правил
описывает состояние после T110.

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
`clients.desktop` описывает состояние после spec 029.

**spec 031 (22 окт 2026): android без протокола v1.** Монолит `android/jni/parvane_jni.cpp`
удалён вместе с Rust-библиотекой v1 `backend/shared/parvane-e2e` (Olm/Megolm), мостом
`BridgeTransport`, курсорами синка (`cursors.json`, `pending.json`), очередью починки,
повтором `msg.chat.read`, легаси-копиями и сценариями v1/двойного стека
(`tgx_protocol_v2_flow.sh`, `tgx_link_flow.sh`, `tgx_link_e2e.sh` и др.). JNI переписан
модулями поверх `v2::Session` / `v2_account` / `Control` ядра — того же списка исходников
`parvane_core`, что у desktop (сторож `android/tools/check_core_sources.sh`): `jni_main.cpp`
(журнал истории, ORDER-1), `jni_session.cpp` (вход, события сессии), `jni_messages.cpp`,
`jni_groups.cpp`, `jni_account.cpp`, `jni_calls.cpp`, `jni_push.cpp`, `jni_sections.cpp`,
`jni_planner_ops.cpp`. Каталог устройства прежней версии стирается при первом запуске.
Пункты правил о v1-пути (SYNC-1/2, READ-1, E2E-1, KEY-1, SEND-1, EPHEMERAL-1, GROUP-1,
LEGACY-1, GROUP-4, E6-1, LINK-1) для android закрыты удалением кода: сторож проверяет, что
v1-кода в `android/jni` нет, остальные android-пункты смотрят в модули `jni_*.cpp` и шов
`android/libtd`. Поле `clients.android` описывает состояние после spec 031; там, где
android сделан не полностью, — пометка «ОТКРЫТО».

**spec 035 (11 ноя 2026): смысл решает движок (ENGINE-1).** Поверх движка `parvane-protocol` появилась модель
(`backend/protocol/src/model/`, схема `proto/parvane/engine/v1/model.proto`, типы клиентов генерируются —
`web/telegram-tt/src/api/parvane/v2/gen/model.ts`, `desktop/parvane-core/include/parvane/gen/model.h`,
`android/libtd/src/main/java/org/parvane/gen/Model.kt`): клиент подаёт намерения и ввод сервера, модель сама
разбирает содержимое (`MessageView`), сводит личное состояние (журнал `state.v2`, `StateView`), ведёт сведения и права
групп (`GroupView`, `Capabilities`) и отдаёт готовые представления; хранилище — пачками `store_batch`, которые хост
фиксирует до запросов того же итога (SYNC-1). Клиенты перешли на модель режимом хоста (`host_driven`, единая точка
входа `clientCall`/`historyCall`, `backend/protocol/src/host/call.rs`): web — фаза 11, desktop — фаза 12, android —
общее с desktop ядро и JNI-очередь событий (фаза 13; перевод шва `libtd` — T136, в работе). Имена прежних поштучных
экспортов обвязок в правилах ниже (`PvClient`, `PvState`, `PvHistory`, `pv_client_*`, `pv_state_*`, `pv_history_*`) —
исторические: эти экспорты удалены (T118 web, T129 desktop), те же действия идут через `clientCall`. Правила, смысл
которых теперь решает модель, — STATE-1, HIST-1, HIST-2, GROUP-2, GROUP-3, GPHOTO-1, TYPING-1, REVOKE-1, PACK-1,
PROTO-1, CONTENT-1, FED-1, DOMAIN-2 — дополнены абзацами «с spec 035»; LEGACY-1 закрыт. Сводка — ENGINE-1 (после
PROTO-1).

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
android до spec 031 — `jni/parvane_jni.cpp` (`g_diskCursorId` → `cursors.json`); со spec 031
курсора v1 нет: новое отдаёт инбокс v2 (курсор — в ядре), показанное пишется в журнал истории
`android/jni/jni_main.cpp`. Тест android — сценарий на эмуляторе
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
android — до spec 031 `jni/parvane_jni.cpp` (`kRepairAttempts` = 3); со spec 031 курсора и
очереди починки нет (строки приходят расшифрованными движком v2).

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

**С spec 033 (30 окт 2026) прочитанное своими устройствами — правило READ-2 (маркер «прочитано до» в журнале
истории аккаунта).** Из READ-1 остаётся п. 3 в виде v2: квитанция `RECEIPT_KIND_READ` собеседнику повторяется
до успеха. Web: очередь квитанций `messages.ts` (`queueReceipts`/`flushReceipts`, повтор с паузой 5 с → 2 мин,
переживает перезагрузку — `localState.loadPendingReceipts`); локального списка прочитанных uuid (`readuuids`,
`reportedReadUuids`) больше нет — он один раз переносится в маркеры (FR-024).

`msg.chat.read` уходит без ответа. Клиент обязан:

- записать прочтение локально ДО публикации (переживает перезагрузку);
- считать сообщение прочитанным по объединению локального журнала и серверного флага;
- повторять публикацию, пока сервер не вернёт `read=true`.

Реализации: web `localState.loadReadUuids/saveReadUuids`, `retryUnconfirmedReads`;
desktop `g_reportedRead` + `tdata/parvane-read.txt`, `RetryUnconfirmedReads` (9 сен 2026);
android со spec 031 — `android/jni/jni_messages.cpp` `nativeMarkRead` (строка `read` в журнал
истории ДО квитанции, квитанция — E2E-содержимое v2 через движок; повтора `msg.chat.read` нет). Тест android —
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
- android (spec 031): отказ авторизации v2-сессии (событие `authRejected`,
  `android/jni/jni_session.cpp`) → событие `session failed` (`reason=auth`) →
  `Client.kt` `sessionExpired()`: стор очищен, `session.json` снят, журнал истории
  сохранён, X переводится в `LoggingOut → WaitPhoneNumber` (не `Closed` — тот
  стирает данные). Обрыв gateway: сессия ядра переподключается сама (сеть
  вернулась — `nativeNetworkAvailable`). Тест — `android/tgx_conformance_flow.sh`,
  шаги 4 (`gateway_restart` → реконнект → следующее сообщение доставлено)
  и 5 (отзыв устройства с alice-desktop → экран входа).

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

**`sticker_id` и избранное (spec 035, 8 ноя 2026; FR-075, R13).** `Sticker.sticker_id` — id элемента манифеста
архива набора: имя файла записи индекса PVPK (basename, расширение `.webp`/`.png`/`.tgs`/`.webm`, ≤ 64 байт), то есть
то, что видит каждый клиент, установивший набор (web `stickerPacks.ts`, ядро `pack_archive.cpp` `build`/`parse`), —
а НЕ `file_id` загрузки (у каждой загрузки свой; web до перехода заполняет `sticker_id` значением `file_id`,
`v2/contentMap.ts`). Стикер без набора — пусто. Проверка — движок `msg::is_pack_sticker_id`, векторы
`proto/parvane/vectors/content/sticker_id.json` (тест `vectors_sticker_id`). Избранные стикеры — объект личного
состояния state.v2 `FAVED_STICKER` (ключ `set_id ‖ "/" ‖ sticker_id`, значение — `media` и время, до 200, как Telegram),
синхронизируются между своими устройствами; «В избранное» в ленте — во всех клиентах.

**С spec 035 (11 ноя 2026) — по модели движка.** Объект `OBJECT_KIND_FAVED_STICKER = 20` журнала `state.v2` и
намерение модели `fave_sticker` (`IntentFaveSticker`, вектор `proto/parvane/vectors/model/fave_sticker.json`) есть;
`sticker_id` при отправке и в ленте заполняет движок (`contentOfWire`/`contentView`,
`backend/protocol/src/model/views.rs`), а не клиент. Клиенты: web — «В избранное» в ленте и избранные из журнала
(`provider.ts`, `v2/stateJournal.ts favedStickers`; e2e `scripts/run_web_fave_sticker_e2e.sh` — синхронизация на
второе web-устройство); desktop — через журнал состояния ядра (`Session::stateFaveSticker`, tdesktop
`parvane_client_state.cpp`; id набора и элемента — `pack_archive.h` `favedSetId`/`favedStickerId`, общий вектор
`proto/parvane/vectors/clients/sticker-ref.json`); android — объекты модели
(`jni_account.cpp` `stateFaveSticker`/`stateFavedStickers`, `Stickers.kt`; сторож ENGINE-1 android).

**С spec 036 (13 ноя 2026) — общий id набора, сделано во всех трёх клиентах.** id набора у всех клиентов — ключ объекта
`STICKER_PACK`: `h:` + отпечаток содержимого (PACK-2, base64 как на проводе — может содержать «/») либо, у ссылки без
отпечатка, `n:` + нормализованное имя; id стикера — имя файла манифеста (и на проводе `Sticker.sticker_id`). Избранный
стикер — `set_id ‖ "/" ‖ sticker_id`, делится последним «/» (намерение `fave_sticker` отвергает «/» только в id
стикера; вектор `model/fave_sticker.json`). Общий вектор — `proto/parvane/vectors/clients/pack-set-id.json` (движок
`packSetId`, web `favedIds.ts`, ядро `pack_archive.h sharedSetId` — `webcompat_tests`, android
`PackIndexTest.sharedSetIdMatchesVectors`). Одноимённые наборы разного содержимого — два набора у каждого клиента (web:
и рядом со своим установленным — `localHashBySetId` в `stickerPacks.ts`; desktop — каталог по отпечатку; android —
локальный id по отпечатку). Прежние id избранного (`pvpk-…` desktop/web, числовые шва android) перекладываются на общий
один раз. Сценарий трёх клиентов — `android/tgx_pack_set_flow.sh` (`scripts/run_protocol_mixed_e2e.sh pack-set`, web-часть
`scripts/e2e_pack_set_web.mjs`): bob (desktop) и carol (web) шлют стикеры своих «Котики» с одинаковыми именами файлов и
разным содержимым; у alice (desktop + X) и carol — по два набора; «В избранное» на desktop показывается в X из набора
carol, на X — в desktop, web пишет те же `h:<отпечаток>/<файл>`, что посчитал раннер.

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
проверяет web `clientVectors.test.ts`), `tests/v2_tests.cpp`. Android (spec 031) — частично:
`android/jni/jni_messages.cpp` кладёт `content_hash` в ссылку (`nativePackRefFor`, кэш ссылок по
отпечатку), одноимённый набор с другим отпечатком ставит отдельным каталогом «<имя> <6 hex>»
(`nativePackFetch`, `hashTag`), `nativePackHash` — отпечаток установленного набора. ОТКРЫТО: скачанный
архив с отпечатком не сверяется, тот же набор под другим именем не находится; теста нет.

## PACK-3. Свои наборы стикеров и эмодзи — на всех своих устройствах

Набор, установленный на одном своём устройстве (пришёл в сообщении либо создан из своих файлов), появляется на
остальных своих устройствах (5 ноя 2026, указание пользователя). Носитель — журнал личного состояния, вид `packs`:
запись `state.v1.StickerPack` = общий ключ набора, ссылка на архив (поля `PackRef` сообщения: архив PVB2 в облаке
по секрету capability, CAP-1), признак эмодзи, время установки; снятие — `sticker_pack_remove`.

1. Ключ набора общий для клиентов: `h:<content_hash>` (отпечаток PACK-2), у ссылки без отпечатка —
   `n:<sanitizeName(имя)>`. Локальные id наборов у клиентов разные (разные хеши) — в журнал не пишутся.
2. Установка — запись; набор без ссылки (свой) сперва загружается в облако тем же путём, что при отправке стикера.
3. Другие свои устройства: набора из журнала нет — скачать архив по ссылке, сверить отпечаток (PACK-2), поставить без
   вопроса; снятый в журнале — снять.
4. Наборы, установленные до правила, переносятся в журнал один раз на устройство (дальше главнее журнал).

Сервер содержимого журнала не видит (шифртекст), состав наборов остаётся у устройств пользователя.

## GIF-1. Свои GIF — на всех своих устройствах (7 ноя 2026)

Сохранённые GIF (из чата — «Сохранить в GIF», из файла — «Загрузить GIF» на вкладке GIF) одинаковы на всех своих
устройствах (указание пользователя 7 ноя 2026). Протокол не меняется: носитель — тот же журнал личного состояния, вид
`packs` (PACK-3), запись `state.v1.StickerPack`:

1. `set_id` = `g:<sha256 содержимого файла, hex>`; `emoji` = false; `added_ms` — время сохранения (порядок: новые
   первыми).
2. `ref` — ссылка на САМ файл GIF (не архив PVPK1): `file_id`, `key`/`nonce` (если файл зашифрован ключом
   сообщения), `capability` (CAP-1), `blob_domain`; `name` — имя файла с расширением (`.mp4`, `.webm`, `.gif` — по нему
   тип), `count` = 1, `content_hash` — тот же sha256 (сырые 32 байта).
3. GIF из чата уже лежит в облаке — запись берёт ссылку из сообщения, файл заново не загружается. GIF из файла
   загружается тем же путём, что вложение чата (PVB2 по секрету capability).
4. Удаление из сохранённых — `sticker_pack_remove` с тем же `set_id`.
5. Другие свои устройства: записи `g:` — не наборы стикеров (архив не разбирать); скачать файл по ссылке, сверить
   sha256, добавить в «Сохранённые GIF»; снятую — убрать.
6. Клиент, не знающий GIF-1, запись `g:` как набор не установит (архив не разберётся) — вреда нет.

## CONTACT-1. Свои контакты, своё имя контакта и заметка (7 ноя 2026)

Как `contacts.addContact` Telegram: «Новый контакт» и «Изменить» в профиле собеседника задают своё имя и фамилию и
«Заметку»; видны они только владельцу и одинаковы на всех его устройствах. Носитель — журнал личного состояния, вид
`contacts`, запись `state.v1.Contact` (`contact_set` = 38, `contact_remove` = 39, снимок `contacts` = 19):

1. Ключ — собеседник-пользователь (`user`); группа контактом не бывает (движок отвергает). Запись целиком по метке
   (LWW), удаление из контактов — надгробие `contact_remove` с `PeerKey` пользователя.
2. `first_name`, `last_name` (≤ 256 байт) — своё имя; оба пусты — показывать имя, заданное самим собеседником.
   Форма, предзаполненная именем собеседника и сохранённая без правки, своего имени не задаёт.
3. `note` (≤ 4096 байт, простой текст) — заметка о контакте.
4. Своё имя подставляется в шапки, список чатов, звонки и уведомления, но в провод не уходит: в заголовок пересылки
   (`ForwardInfo.from_name`) пишется имя, заданное самим собеседником.
5. Удаление контакта стирает и имя, и заметку.
6. Явные контакты, добавленные до правила, переносятся в журнал один раз на устройство и только недостающими —
   контакты разных устройств складываются, а не вытесняют друг друга. Правки, сделанные без связи, дописываются
   поверх журнала без удалений.
7. Клиент, не знающий вида, записи пропускает без ошибок (движок общий; неизвестный вид — «пропустить, метку учесть»).

Реализации: движок `backend/protocol/src/state.rs` (`contact_key`, `Managed.contacts`, тест
`contacts_diff_merge_and_migrate`, вектор `proto/parvane/vectors/state/merge.json` «контакты (CONTACT-1)»); web `contactInfo.ts`, `v2/stateJournal.ts` (`showContacts`), `store.ts`
(`getContactName`, `getPublicDisplayName`), `provider.ts` (`updateContact`, `updateContactNote`, `importContact`,
`deleteContact`); тест `contactInfo.test.ts`. Desktop (7 ноя 2026, этап 4): `parvane_client_state.cpp` (вид `contacts`,
`SetContact`/`RemoveContact`), `ensurePeerUser` (флаг контакта, своё имя, заметка), родной бокс правки контакта и меню
профиля; сценарий `desktop/verify_contacts.sh`; явных контактов до правила desktop не хранил — переносить нечего.
Android (8 ноя 2026, этап 4): `StateJournal.kt` (вид `contacts`), `ChatLocalState.kt` (`contacts.json`), `ContactNames.kt`
(порт `contactNameOverride`), `ParvaneStore.kt` (`displayName`/`publicName`), `Client.kt` (`AddContact`, `RemoveContacts`,
`SetUserNote`, `UserFullInfo.note`), «Изменить/Удалить контакт» и поле «Заметка» X (`setup-tgx.sh` PYREV4); тест
`Review1107Phase4Test`, пара sections-android (`e2e_protocol_sections_android.mjs`); явных контактов шов не вёл.

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
`tests/webcompat_tests.cpp` (очистка названия как web). Android (spec 031): `android/jni/jni_calls.cpp`
(`nativeGroupStart` → `GroupCallManager::startCall` с адресом и названием группы, приглашение —
событие `group_call` с `cleanGroupTitle`), окно и экран — `GroupCallController.kt` оверлея; сценарий
`android/tgx_group_call_flow.sh`. ОТКРЫТО (мелочь): для известной группы окно приглашения
показывает название из приглашения, а не своё из журнала.

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
`blob_domain`. Android (spec 031): адресат запросов, жетоны сервера адресата, домены групп и блобов —
общее ядро (тот же список исходников `parvane_core`, что desktop); профиль адреса чужого сервера —
`android/jni/jni_account.cpp` `nativeResolve` (`resolveProfiles` по доменам). ОТКРЫТО: причины отказа
(п. 5) шов строками не показывает; сценария двух серверов на эмуляторе нет.

6. **Подписки на группы других серверов (spec 035, 8 ноя 2026; PV-014).** Записи группы чужого сервера
   (`S2sInboxPush`: конверты и уведомления журнала) сервер кладёт в инбокс своего пользователя, только если тот
   подписан на эту группу (`group.remote.subscribe{group}` при вступлении, `group.remote.unsubscribe` при выходе;
   таблица `remote_group_subscriptions`, до 5000 на пользователя); иначе запись отбрасывается молча — ответ об
   ошибке выдал бы чужому серверу членство. Свой сервер при этом знает, в каких чужих группах состоит его
   пользователь: это **маршрутный метаданный**, без которого доставка невозможна (принцип III), — содержимое и
   состав группы ему по-прежнему не видны. Подписку ставит клиент (модель движка — при вступлении и в разовом
   переносе на все свои удалённые группы). Тест: messenger `v2_fed::tests::push_of_unsubscribed_group_is_dropped`.
   Живой — `parvane-integration --test v2_federation_live` (`federation_push_of_unsubscribed_group_is_dropped`;
   законные сценарии федерации подписываются при догоне журнала группы, как модель).
   **С spec 035 (11 ноя 2026) подписку ставит модель движка**, не клиент: при каждом изменении сведений группы
   чужого домена (`refresh_groups`, в режиме хоста — на шаге `flush`) модель выпускает `group.remote.subscribe`
   (стал участником) или `group.remote.unsubscribe` (вышел, исключён, группа удалена), хост лишь отправляет запросы
   итога. Web, desktop и
   android (общее ядро) свою подписку не собирают. Сервер федерации принимает кадры партнёров только с
   `proto_minor ≥ PROTO_MINOR_035`, ниже — `UPGRADE_REQUIRED` (PROTO-1). ОТКРЫТО: web `run_web_federation_e2e.sh` в
   прогонах фазы 11 на стенде MSI красный (был красным и до правок фазы, не разобран); desktop
   `verify_federation.sh` зелёный (прогон фазы 12).

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

Реализации: web — с spec 036 T020 ревизию ведёт модель (сведения — показ `viewGroup`, своей проверки версии у web
нет); прежде `api/parvane/store.ts` (`shouldApplyGroupInfo`, `registerGroup`),
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

Реализации: с spec 035 (T114, ENGINE-1) формула — в движке (`backend/protocol/src/model/capabilities.rs`,
`GroupFacts::hides` и `capabilities`; ссылка в подписи медиа — тоже ссылка); web своей формулы не держит:
`api/parvane/sync.ts` (`isHiddenByGroupPermissions` → `contentHidden` модели, live + full sync, журнал
`group-perm-hidden`; ссылки, которые приёмник разметит при показе, — `autoEntities.ts withDetectedLinks`),
композер — `currentUserBannedRights` из `capabilities` модели (`defaultBannedRights` — показ прав по умолчанию);
desktop своей формулы тоже не держит (spec 035 T126): `parvane-core` `v2_session.cpp`
(`Session::contentHidden` → `contentHidden` модели, `Session::canSendContent` → `capabilities` модели и тот же
фильтр для своего содержимого) + `parvane/parvane_client.cpp` (`injectOnMain`, маркер
«скрыто правами группы»; пересылка в группу — `canSendContent`; композер — нативные `defaultRestrictions` через
`amRestricted`); android `libtd/.../ParvaneStore.kt` (`isContentAllowedForMember`)
+ `Client.kt` (приём), композер — `Chat.permissions`. Тесты: web
`conformance.test.ts` (GROUP-2: таблица кейсов + grep desktop/android);
desktop `desktop/verify_conformance_perms.sh` (файл в обход скрыт,
владелец не фильтруется, композер блокирует) и parvane-core
`parvane_group_client_tests`; android — JVM `ParvaneStorePermsTest` и сценарий
на эмуляторе `android/tgx_group_manage_flow.sh` (файл участника без права
скрыт и в чат не попал, после возврата права показан; зелёный 27 сен 2026).
Правило закрыто на всех клиентах.

**С spec 035 (11 ноя 2026) — права решает модель (ENGINE-1).** Формула одна — в движке
(`backend/protocol/src/model/capabilities.rs`: `GroupFacts::hides` для приёмного фильтра, `capabilities` для композера
и меню — медиа, стикеры, опросы, ссылки, а также «удалить у всех» и закреп для админа), сведения группы — из её
журнала (GROUP-3). Вызовы модели: `contentHidden{chat, from, wire}` (скрыть ли входящее) и `capabilities{chat}`;
вектор `proto/parvane/vectors/model/group_perms_media.json`. Web и desktop своей формулы не держат (сторожа ENGINE-1 web
и desktop: в `groups.ts` нет `isContentAllowedForMember`, в ядре — `group.h`/`chat_rules.h` без формулы GROUP-2).
ОТКРЫТО: android пока считает права своей формулой `ParvaneStore.isContentAllowedForMember` (шов `libtd`, T136 — в
работе, android-ветка не слита); таблица `cases` по-прежнему сверяет её с движком.

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
   `{device_id: <новое>, eph_pub: <свой эфемерный P-256>, wrap}`. Сервер фиксирует
   первый challenge и не даёт его заменить; `wrap` — обёртка ключа для других
   своих устройств (п. 13).
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
   (`linkGrantMaterial`: JSON `{ssk, log, dk, gen, sk, skv, fsk}` — self-signing-ключ,
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
   **Корня личности в материале нет** (20 ноя 2026, RECOVER-1 п. 8): корень хранится только на устройстве, где был
   открыт; привязанное грантом устройство получает лишь копию корня под ключом восстановления (`rb`) и спрашивает
   ключ для операций корнем (тест `root_is_kept_on_disk_only_sealed_and_only_for_own_log`: материал корня не несёт).
8. **История v2-эпохи (spec 007, T138, SC-002)** — **С spec 033 (30 окт 2026) история в экспорт привязки НЕ
   кладётся и из него не читается**: новое устройство берёт её из журнала истории аккаунта (HIST-1/HIST-2), прежнее
   поле `v2History` игнорируется (снимок без надгробий возвращал удалённое). Экспорт несёт `linkVersion: 2`,
   `planner`, `cloud`. Web — `v2/linkKeys.ts` (`parseLinkPlannerKeys`, `parseLinkCloudKeys`); ручная копия ключей
   (`keyBackup.ts`) тоже без истории. Ниже — прежняя редакция пункта (история). Сообщения v2 запечатаны под
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

11. **Ключи «Плана» и «Облака» в экспорте привязки (spec 010/016; desktop и android — 24 окт 2026)** — экспорт
    несёт `planner` и `cloud` строками JSON движка (`plannerKeysExport` / `cloudKeysExport`), новое устройство
    импортирует их сразу после вступления в журнал: разделы открываются без ожидания другого своего устройства.
    web — `provider.ts parvaneGrantLink` / `parseLinkPlannerKeys`, `parseLinkCloudKeys`; desktop и android — ядро
    `keybundle::putLinkDomainKeys` / `readLinkDomainKeys` (`parvane_client_linking.cpp`, `jni_account.cpp`).
12. **Ключи уровня аккаунта новым своим устройствам (24 окт 2026)** — вместе с группами (п. 9)
    `shareGroupsWithOwnDevices` пересылает ключ доставки (`DeliveryKeyShare`) и ключ личного состояния
    (`StateKeyShare`); приём — только более новой версии. Копия ключей аккаунта при записи сводит грант: свой, но
    `sk`/`skv` и `dk`/`gen` — более новой версии из двух (вектор `clients/keybundle-merge.json`). Без этого
    устройство, вошедшее по копии, которую последним записало отставшее устройство, оставалось на прежнем ключе
    личного состояния навсегда (новые записи журнала не читались, свои — не читались другими). Тест — движок
    `revocation_flow.rs revocation_rotates_keys_epochs_and_ssk`.
    **Прежние ключи личного состояния (20 ноя 2026, дефект `relink`)**: материал гранта несёт поле `fsk` —
    `[{k: hex, v: версия}]`, прежние ключи состояния (новые сначала, до 16). Ключ журнала истории выводится из ключа
    состояния; без прежних ключей устройство, привязанное после смены ключа отзывом, не открывало записи истории,
    сделанные до неё (третья привязка теряла всю переписку). Копия ключей аккаунта сводит `fsk` объединением обеих
    копий плюс вытесненный свой `sk` (вектор `clients/keybundle-merge.json`). Тест — движок
    `host::tests::link_grant_carries_former_state_keys_for_history`; desktop/android — ядро `keybundle.h` сводит
    без `fsk` (их этап).

13. **Запрос виден и подтверждаем на ЛЮБОМ старом устройстве (31 окт 2026, решение пользователя)** — раньше
    challenge «забирало» первое ответившее устройство: остальные видели в оффере чужой `challenge_pub`, не знали его
    закрытой части и запрос не показывали (прод-подобный стенд 31 окт: телефон открыл шторку, desktop с
    автоподтверждением запрос не увидел). Теперь устройство, выставляющее challenge, кладёт рядом обёртку закрытой
    части своего ключа (32 байта P-256, big-endian):
    `ctx = "parvane/v2/link-challenge\0" ‖ u32be‖адрес ‖ u32be‖устройство-цель ‖ u32be‖commitment ‖ u32be‖challenge_pub`
    (строки — как на проводе, base64), `key = HKDF-SHA256(ikm = SSK seed, salt — нет, info = ctx)`,
    `wrap = nonce(12) ‖ AES-256-GCM(key, nonce, d, aad = ctx)`; поле `LinkChallengeRequest.wrap`, сервер хранит его
    рядом с первым challenge (`link_offers.challenge_wrap`, миграция identity `0018`) и отдаёт всем старым устройствам
    в `LinkOffer.challenge_wrap`. Повтор challenge тем же ключом обёртку не меняет; новый оффер сбрасывает обе.
    Другое старое устройство открывает обёртку движком (`linkChallengeUnwrap`), проверяет, что закрытая часть даёт
    именно `challenge_pub`, показывает тот же код `SHA-256("parvane-link-sas-v2" ‖ new ‖ challenge)` и по
    подтверждению запечатывает грант ЭТИМ ключом. Новое устройство не меняется: код один на всех устройствах, грант
    принимается под ключ challenge (п. 5), кто бы из старых его ни выдал. Сервер принимает грант только под
    зафиксированный challenge (грант под чужой ключ оффер не гасит) и после гранта убирает оффер — у остальных
    старых устройств окно закрывается (web — диалог подтверждения на экране «Устройства», desktop —
    `g_linkBoxes`, android — событие `link_request_gone`). Безопасность LINK-1 не ослаблена: ключ обёртки выводится из
    SSK, которого у сервера нет; открыть обёртку могут ровно устройства, способные выдать грант (материал гранта
    требует SSK); открытие доказывает, что challenge выставило своё устройство к ЭТОМУ обязательству и ключу (AAD и
    info), — сервер не может ни подставить свой challenge другим старым устройствам, ни перенести чужой на другой
    оффер, а ключ challenge по-прежнему появляется после обязательства и до раскрытия ключа нового устройства.
    Обёртка не открылась (устройство без SSK, клиент без п. 13, подмена) — запрос на этом устройстве не показывается,
    как раньше. Отказ на android (`declineLink`) запоминается по обязательству — ключ из обёртки не возвращает запрос.
    Реализация: движок `backend/protocol/src/link.rs` (`Client::link_challenge_wrap/unwrap`, WASM
    `linkChallengeWrap/Unwrap`, хосты — `call("linkChallengeWrap"/"linkChallengeUnwrap")`), identity `link.rs`
    `store_link_challenge`/`store_link_grant`; web `provider.ts describeLinkOffer`/`adoptLinkChallenge`, `linking.ts`
    (`generateLinkChallengeKey`, `exportLinkPrivateScalar`, `importLinkPrivateScalar`); ядро
    `linking.h EphemeralKey::privateScalar/fromPrivateScalar`, `Session::linkChallengeWrap/Unwrap`; desktop
    `parvane_client_linking.cpp AdoptLinkChallenge`; android `jni_account.cpp adoptLinkChallenge`. Тесты: движок
    `link::tests`, identity `link_challenge_shared_by_all_old_devices`, живой `parvane-integration --test v2_link_live`,
    web `conformance.test.ts` (LINK-1 п. 13), ядро `linking_tests` (обмен закрытой частью).

14. **Отказ в привязке и подпись запроса (spec 041, 21 ноя 2026; web)** — «Отклонить» на своём устройстве журнала —
    `LinkGrantRequest.decline = 4` (пустые бокс и ключ): identity гасит оффер (у всех старых устройств запрос
    исчезает) и кладёт новому устройству одноразовую отметку, которую оно видит в любом своём опросе как
    `LinkPollResponse.declined = 4`; грант под погашенный оффер не принимается, новый оффер снимает отметку. Отказать
    может только устройство журнала (как и выдать грант): вошедший одним паролем сорвать привязку не может. Новое
    устройство, увидев отказ, перестаёт опрашивать и показывает «Запросить снова» (новый оффер). Запрос несёт
    `LinkOffer.label = 8` — как новое устройство назвало себя при входе (`SessionIssueRequest.client_kind`), только
    показ; отдаётся лишь устройствам журнала. web — `provider.ts parvaneDeclineLink` / `noteLinkDeclined` /
    `parvaneRequestLinkAgain`, экран `SettingsActiveSessions.tsx`, `devices/DeviceConfirmSignIn.tsx`; desktop и android
    поля пока не читают (отклонение у них — только локально, как до п. 14). Тесты: identity
    `link_decline_voids_offer_and_reaches_new_device_once`, живой `v2_link_live link_request_is_declined_by_own_device_live`,
    сценарий `e2e_web_linking.mjs`.

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

**С spec 035 (11 ноя 2026) — журнал `state.v2`: сведение по полям, сводит только модель.** Всё выше описывает журнал
`state.v1`: LWW по объекту целиком терял одно из двух одновременных правок разных полей одной папки или контакта
(тест движка `state::tests::concurrent_field_edits_lost_v1` фиксирует прежнее поведение). С этого выпуска сервер
перестал принимать `state.append`; после разового переноса (T149, 12 ноя 2026) методы `state.append`/`state.sync` и
таблица прежнего журнала (`user_state_log`, миграция messenger `0014_drop_state_v1.sql`) удалены.

1. **Журнал.** `state.ops.append` / `state.ops.sync` (шард messenger `v2_state.rs`, таблица `user_state_log_v2`,
   миграция `0007_user_state_log_v2.sql`); повтор `op_id` с теми же байтами — прежний `seq`, с другими — `DUPLICATE`;
   лимиты и страница синка — те же, что у `state.v1` выше. Живой тест — `parvane-integration --test v2_state2_live`.
2. **Объект** — `(вид, ключ)` (`proto/parvane/state/v2/state.proto`, `ObjectKind`: папка, порядок папок, блок-лист,
   уведомления и умолчания, черновик, отложенное, архив, список закрепа, звонок, ссылка-приглашение, контейнеры
   «Плана» и «Облака», «непрочитано», быстрая реакция, свои наборы, свои GIF, контакт, очистка чата, избранный стикер).
   Операции — `Create`, `Patch{set, clear}`, `Delete`, `SetAdd`/`SetRemove`, `Mark`, `Migrated`.
3. **Сведение** (`backend/protocol/src/state2.rs`): у каждого поля свой регистр с меткой `(lamport, device_id,
   op_id)`, ничья — байтами значения (очистка меньше любого значения); элемент множества — регистр «есть/нет»;
   отметки только растут и сильнее надгробия (`SCHEDULED` 1 — «отправлено», `CHAT_CLEARED` 2 — граница очистки).
   Объект виден, если самая свежая метка среди `created`, полей и элементов новее надгробия; в показ идут только
   поля новее надгробия. Итог побайтно один при любом порядке, повторах и разбиении. Отказы зависят только от самой
   операции (плохой ключ, `lamport` 0 или больше потолка приёма `ACCEPT_LAMPORT_CEILING` = 2^40, поле сразу в `set`
   и `clear`, зарезервированные папки, значение сверх лимита схемы).
4. **Непонятое** (CONTENT-1, «критичность»): неизвестное поле значения и неизвестный вид объекта хранятся исходными
   байтами и сводятся как известные, в показ не попадают; при непонятой записи заменяющий снимок запрещён
   (`RangeHeld`); критичный вид операции (1000–1999) закрывает журнал для записи — модель отдаёт
   `writeBlocked{journal, CRITICAL_UNKNOWN}`, клиент показывает «обновите приложение», чтение известного работает.
5. **Шифрование**: `nonce(12) ‖ ChaCha20-Poly1305(StateOp)`, AAD = `"parvane/v2/state2\0" ‖ user ‖ op_id`; повтор
   неотправленной записи — с детерминированным nonce (`HMAC-SHA256(ключ, "parvane/migrate/nonce\0" ‖ op_id ‖ текст)`;
   метка — от разового переноса spec 035, байты не менять): повтор даёт те же байты, сервер отдаёт прежний `seq`.
   Записи `Migrated{from_seq}` разового переноса остаются в журналах и понимаются движком.
6. **Клиенты не сводят** (ENGINE-1): с spec 036 (web T019, desktop T028, android T034) — по видам: показ
   `viewStateJson` (объекты со значением в proto3-JSON сообщения вида), правка
   `stateSet{kind, key, value | delete, base?, rewrite?}` / `stateMark` (`backend/protocol/src/model/state_json.rs`);
   модель сама выпускает изменившиеся поля (`Patch`), новые и пропавшие объекты и отметки (списки, в том числе
   `Folder.include_peers`, — регистром целиком); разницу по полям с показанным (`base`) считает модель. Прежний мост
   снимка формы `state.v1` (`stateApplyV1`/`stateViewV1`, `model/state_v1.rs`) удалён 13 ноя 2026 (spec 036 T038):
   ядро desktop/android пишет контейнеры, звонки, ссылки, отметки и перенос под новый ключ теми же `stateSet`/`stateMark`.
   Своя правка без связи уходит при подключении разницей от показанного ДО правки, а не от
   только что сведённого (иначе откатывала правку другого устройства).

Векторы — `proto/parvane/vectors/state2/` (`patch`, `sets`, `ordered`, `delete_vs_edit`, `marks`, `unknown_fields`,
`rejected`; набор `state2/*` в `conformance::run`) и `proto/parvane/vectors/model/state_patch_folder.json`; тесты
движка `tests/state2_vectors.rs`, `tests/state2_props.rs` (≥ 2000 перестановок и разбиений → один снимок).
Клиенты прогоняют наборы `state2/*` той же обвязкой, что `state/merge`: web
`protocol.vectors.test.ts`, ядро `protocol_vectors_tests.cpp`, android `ProtocolV2SeamTest.kt`. Реализации: web
`v2/stateJournal.ts` (виды личного состояния после первой проекции живут в памяти, на диске — только ещё не принятая
журналом правка; `localState.ts`, тест `localState.modelBacked.test.ts`); desktop — ядро `state_model.cpp`
(`Session::stateSubmit` — объекты вида с показанными как базой разницы) и tdesktop `parvane_client_state.cpp`; android — то же
ядро (`jni_account.cpp` `stateSubmit`/`stateView`), шов `StateJournal.kt`. Сценарии «две правки разных полей без связи»: web
`scripts/run_web_state_patch_e2e.sh`, web↔desktop `scripts/run_protocol_mixed_e2e.sh state-patch-desktop` и
`desktop/verify_state_patch.sh`, android `android/tgx_state_patch_flow.sh`. Показ и правка по видам — web
(`v2/stateObjects.ts`, spec 036 T019), desktop (`state_model.cpp` `stateview`, T028) и android (`StateJournal.kt`
`show(view)`/`objects(kind, shown)`, T034).

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

**С spec 035 (11 ноя 2026) — показ решает модель, у вида есть критичность.**
1. **Разбор — только движок** (ENGINE-1): класс, поля показа, мутации и ответ входящего — `content_view` движка
   (`backend/protocol/src/model/views.rs`; событие записи несёт готовый `view`), исходящее — `contentOfWire`. Модель
   отдаёт строку `MessageView` с `disposition: SHOW | STUB | STUB_CRITICAL` и телом `ViewBody` уже в виде показа; вид,
   которого клиент не объявил в `features` (`backend/protocol/src/model/features.rs`), отдаётся текстом его поля
   `text` (вектор `proto/parvane/vectors/model/features_text_fallback.json`; TASK-1, CLOUD-1, ARTICLE-1). Своего
   разбора видов нет в web `v2/contentMap.ts` и в ядре `v2_content.cpp` (сторожа ENGINE-1); android-шов
   `ParvaneStore.kt` пока разбирает событие ядра сам (T136, в работе).
2. **Диапазоны номеров** видов во всех oneof журналов и содержимого (`msg.v2.Content.kind`, `state.v2.StateOp.op`,
   виды `history.v1`, изменения `planner.v1`/`cloud.v1`, `GroupStateChange.change`, `InboxRecord.item`):
   **1–999 — обычные, 1000–1999 — критичные** (`specs/035-protocol-evolution/contracts/versioning.md`). Сборка
   движка проверяет, что каждый известный вид лежит в диапазоне; критичных известных видов в выпуске нет (диапазон
   зарезервирован, вид ≥ 1000 есть только в тестовой схеме `proto/parvane/sample/`). Тест — `tests/kind_ranges.rs`.
3. **Неизвестный вид содержимого**: обычный — `STUB` («не поддерживается вашей версией»), ответ и пересылка
   разрешены; критичный (или критичное неизвестное поле) — `STUB_CRITICAL`: та же заглушка с текстом «обновите
   приложение», ответ, правка и пересылка запрещены (`unknown.rs`, `Disposition::StubCritical`). Неизвестное
   обнаруживается по исходным байтам до разбора (`unknown::scan`, векторы `proto/parvane/vectors/unknown/`).
   Векторы — `proto/parvane/vectors/content/critical.json`, `proto/parvane/vectors/model/critical_journal.json`,
   `unknown_content_stub.json` (наборы движка `content/critical`, `model/critical_journal`). В событии прежнего вида критичная заглушка — `disposition:
   "stub"` с `critical: true`. Клиенты (EN+RU): web — `store.ts` (заглушка `critical`), desktop — tdesktop
   `parvane_client.cpp` (`isCriticalStub` → `lng_parvane_stub_critical`), android — `ParvaneStore.kt` (`stub_critical`,
   `SeamText.kt`), тест `CriticalStubTest.kt`.

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
`L2PrivacySeamTest.kt` (сценарий двойного стека `tgx_protocol_v2_flow.sh` удалён в spec 031;
режим L2 на эмуляторе сейчас отдельным сценарием не проверяется).

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
`parvane_webrtc_backend.cpp`). Android (spec 031): `android/jni/jni_calls.cpp` — менеджеры
звонков ядра (`CallManager`/`GroupCallManager`, тот же кодек `call.h`), медиа — `org.webrtc`
из состава Telegram X (`ParvaneCalls.kt`, `Calls.kt`). Тесты: web
`iceCandidate.test.ts`, ядро `call_session_tests.cpp`, сторож
`conformance.test.ts`, сценарии `scripts/run_web_cross_calls_e2e.sh` и
`android/tgx_calls_flow.sh` (desktop ↔ X в обе стороны).

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

**Правило закрыто (spec 035, 11 ноя 2026): протокол v1 удалён везде, v1-устройств нет.** Сервер без v1 с T110
(7 окт 2026, `msg.deliver_legacy` отвечает `UNAVAILABLE`), клиенты легаси-копий не шлют и запись `LegacyV1` целиком
пропускают — web (T110), desktop (spec 029), android (spec 031); сторож `conformance.test.ts` (LEGACY-1) проверяет,
что v1-путь в клиенты не вернулся. Всё выше — история.

**Движок и сервер тоже очищены (T096 spec 035, 11 ноя 2026; на проде записей `legacy_v1` в `inbox_log` и строк
`legacy_origin` — 0).** Удалены: модуль `backend/protocol/src/legacy_v1.rs` (и его fuzz-цель, векторы
`proto/parvane/vectors/legacy_v1/`, набор conformance `legacy_v1/messages`), событие движка `legacyV1` и ветки клиентов
для него, `InboxRecord.legacy_v1` и `LegacyV1Record` (`msg.proto`: `reserved 12; reserved "legacy_v1";`),
`LegacyDeviceSet`/`LegacyDevice` (`envelope.proto`: `UserDeviceLogEntry` — `reserved 7; reserved "legacy_devices";`),
метод `msg.deliver_legacy` (схема, реестр, ACL NATS, обработчик messenger), `legacy_devices_request`/
`legacy_deliver_request`/`import_v1_account(_json)` движка, `SendFormat::LegacyV1` политики, поля
`legacy`/`legacySet`/`legacyKeys` у `logDevices`; таблица `legacy_origin` — новой миграцией messenger
`migrations_v2/0012_drop_legacy_origin.sql`. Прежняя запись журнала устройств с полем 7 остаётся звеном цепочки:
движок принимает её как пустую при подписи текущим SSK и нераскрытом SSK (иначе `BadSignature`/`Forbidden`), чтобы
журналы, созданные до удаления, не ломались (вектор `device_log/alice`). Сторож `conformance.test.ts` (LEGACY-1,
«движок и сервер: остатков v1 нет») проверяет, что ничего из этого не вернулось.

## TYPING-1. «Печатает» в чате v2 — только эфемерным каналом v2

**Spec 007, FR-013/FR-064, D-07 (2 окт 2026).** Кадр v1 `msg.typing.<chatId>`
несёт серверу открытые `{from, to}` из сессии с личностью. В чате v2
(собеседник с журналом устройств либо группа `v2g:`) клиент шлёт «печатает»
только эфемерным каналом v2:

- личный чат — `ephemeral.typing` в канал, выведенный из ключей доставки обоих
  собеседников; группа — `ephemeral.group_typing` анонимным каналом, канал из
  ключа конверта текущей эпохи, подпись ключом отправки эпохи над данными вместе с
  `channel_id` (контекст `group-typing2`, A0015-2; сервер ещё принимает прежнюю подпись без канала
  от старых сборок, публикацию в канал присутствия запрещает в любом случае);
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

**С spec 035 (11 ноя 2026; FR-076).** Прежняя подпись «печатает» группы без `channel_id` (контекст
`parvane/v2/group-typing\0`) удалена из движка и gateway: принимается только `group-typing2` с каналом, запрос со
старой подписью отвергается (тесты `group::tests::typing_legacy_signature_rejected`, gateway
`v2::tests::typing_legacy_signature_rejected`). Утверждение выше «сервер ещё принимает прежнюю подпись от старых
сборок» больше неверно. Подпись строит только движок (`group::sign_group_typing` в `client.rs`), у клиентов своей
подписи нет — сторож `conformance.test.ts` (TYPING-1, spec 035). Экспорты `ephSubscribe/ephTyping/ephOpen` и
`pv_client_eph_*` выше — исторические: клиенты зовут те же действия через `clientCall` модели. Абзац о присутствии
«на v1» устарел с T110 (v1 нет); канал присутствия — движок v2.

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
   сам. Сбой v2-части устройство не «возвращает». Пароль спрашивается при ЛЮБОМ способе выхода («просто выйти»
   и «выйти и сменить ключи»), в том числе с экрана сеансов Telegram X в android (окно оверлея `AccountUi.askTerminate`,
   24 окт 2026: до этого X завершал сеансы без пароля).
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
   мог сменить не только первый клиент. Неверный ключ отклоняется. С 20 ноя 2026 корень остаётся на устройстве,
   где он был открыт (RECOVER-1 п. 8): такое устройство меняет SSK без ключа восстановления, а после своего отзыва
   устройства-держателя SSK — сразу (web `applyRevocation` → `rotateSsk`).
   **Смена SSK — одна запись (spec 035, 8 ноя 2026; FR-074, R12).** Запись `RotateSelfSigning` (подпись корнем)
   несёт `resigned` — сертификаты оставшихся устройств, переподписанные новым SSK (≤ 64; только устройства,
   действовавшие до смены, с теми же ключами и не меньшим `serial`): ни в одной версии журнала собеседник не видит
   «SSK новый, действующих устройств нет» (раньше смена и пересертификация шли разными записями). После версии
   смены запись, подписанная прежним SSK, отвергается (`BadSignature`). «Завершить сеанс» украденного устройства при
   доступном корне — одна операция движка `revoke_device_with_root` (отзыв + смена SSK), поэтому повторное
   «завершить все сеансы» проходит: следующий отзыв подписан уже новым SSK (откаченный 30 окт 2026 запрет больше не
   нужен). Без корня — отзыв как прежде и `ssk_rotation_required`. identity (`log_append`) проверяет тем же движком.
   Тесты: `revocation_flow::ssk_rotation_is_one_entry_and_old_ssk_refused_after`,
   `terminate_all_sessions_twice_with_root`, векторы `proto/parvane/vectors/device_log/ssk_rotate.json`.
   **С переходом клиентов на модель (spec 035, 11 ноя 2026)** запись смены SSK собирает только движок (вызов
   `rotateSsk` единой точки входа модели, `clientCall`) — у web, desktop и android (общее ядро) своей сборки записи
   нет, поэтому одна запись с `resigned` у всех. ОТКРЫТО: одна операция «отзыв + смена SSK»
   (`revoke_device_with_root`) есть только в движке — в единую точку входа не выведена, клиенты по-прежнему зовут
   отзыв и смену SSK двумя вызовами (каждый — одна запись журнала).

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
   ENG-04), но полный выход tdesktop его не зовёт — ОТКРЫТО; android (spec 031) — выход
   `nativeLogout` зовёт `Session::leave` (≤ 5 с) и стирает данные устройства.

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
   - Отметки отзыва (A0007-2, `GroupStateChange.floors`) поднимают порог версии журнала устройств участника.
     Свой порог ставит сам участник; чужой — только тот, кто старше цели (S7-2, 7 ноя 2026): владелец — любому
     другому, админ с правом `ban_users` — только участнику без админских прав. Порог владельцу и другому админу
     от админа игнорируется (иначе младший админ «замораживал» владельца). Ранги — по состоянию группы до записи.
     Движок общий (`group.rs may_floor`, `client.rs revocation_floors` чужих порогов без права не кладёт); тест —
     `group::tests::admin_cannot_freeze_owner_with_floor`.
   - Сообщение несёт `OpHeader.author_log_version`; получатель, знающий журнал
     автора старее, догоняет его до следующей отправки этому пользователю.
   - Уход устройства участника группы сбрасывает свою Megolm-сессию группы и
     требует новой эпохи (`groupInfo.epochStale`); раздача Megolm-ключа уходит и
     своему отправляющему устройству (обманка, ENG-07). Web, кроме того, отправляет
     первый конверт новой сессии через случайные 0,8–2,5 с после раздачи
     (`GROUP_SHARE_GAP_*` в `v2/controller.ts`), чтобы сервер не связывал их по времени.
   Desktop (spec 029): ядро `reportDeviceStolen`, `leftSskHolders`, кнопка — экран
   «Устройства» (`parvane_account_ui.cpp`, `FillReadyExtras`), живой тест
   `v2_session_tests.cpp` (ENG-04). Android (spec 031): то же ядро, JNI `nativeListDevices`
   (`left_devices`) и `nativeReportDeviceStolen`, кнопка — экран аккаунта оверлея
   (`AccountController.kt`).

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
   сценария нет; android (spec 031) — то же ядро, JNI `nativeStoreEscrowCopy` (экрана нет).
8. **Где живёт корень (20 ноя 2026, решение пользователя; пересматривает C1-06 spec 007).** Корень личности
   хранится на том устройстве, где он уже был открыт: создание аккаунта, сброс личности, восстановление и вход по
   ключу восстановления (в том числе ответом боту), успешный ввод ключа в любой операции корнем. Хранит его модель
   движка — запись `engine-core/root` хранилища движка (`backend/protocol/src/model/mod.rs`, `CORE_ROOT`) под DEK
   профиля, как остальные секреты устройства (DEK обёрнут ключом устройства либо PIN); на диск пишется только корень
   СВОЕГО журнала устройств (`Client::owns_root`: журнал есть и его корень — этот), чужой, прежний (личность сброшена
   другим устройством, вердикт `replaced`) или ещё не вступивший в журнал стирается следующей пачкой; новое
   устройство (`clientReplace{new}`) и `forgetRoot` стирают запись. `hasRoot` единой точки входа — «корень своего
   журнала есть на устройстве». Устройство с корнем: смена SSK (и сразу после своего отзыва чужого устройства,
   REVOKE-1 п. 4), новый ключ восстановления, страховочная копия (п. 7) и смена ника (RENAME-1) идут без ключа
   восстановления; смена ника без ключа выпускает новый ключ восстановления — копия корня и ключ копии ключей
   аккаунта привязаны к адресу (RECOVER-2 п. 1). Устройство без корня (привязано грантом) спрашивает ключ, как
   раньше, и после успешного ввода корень запоминает. **Грант привязки и копия ключей аккаунта корень НЕ несут**
   (в гранте — только копия корня под ключом восстановления, поле `rb`); ручная копия устройства (`export` клиента)
   — тоже. Стирание данных аккаунта на устройстве (полный выход, пятый неверный PIN, «Забыли PIN?», отзыв устройства
   сервером) стирает хранилище профиля целиком — с корнем. Тесты: `tests/model_client.rs`
   (`root_is_kept_on_disk_only_sealed_and_only_for_own_log`, `root_goes_with_a_fresh_device_and_foreign_root_is_not_kept`,
   `client_lives_in_the_model_and_survives_reopen`); сценарии web `profile`, `rename`, `telegram_recovery`,
   `run_protocol_mixed_e2e.sh revoke|escrow`. Desktop/android: модель та же (запись пишет движок), но ядро
   `v2_session_account.cpp` по-прежнему зовёт `forgetRoot` после операций — корень у них на устройстве не остаётся
   до своей правки (их T-задача после web).
   **Пароль вместо ключа (20 ноя 2026, решение пользователя).** Новый ключ восстановления на устройстве с корнем
   выпускается только после пароля аккаунта: клиент проверяет его у сервера (`identity.session.reauth`, тот же путь,
   что смена ника) до выпуска ключа; неверный пароль — ошибка, ключ и копия корня не меняются. Так разблокированное
   чужими руками устройство не перевыпустит ключ без пароля. Устройство без корня спрашивает прежний ключ, как раньше.
   Web: `v2/controller.ts renewRecoveryKey(key, password)` (`bad_password`), окно `DeviceKeyDialog` режима `renew`
   (`[data-renew-password]`, `[data-renew-error]`); сценарий `profile`. Desktop/android: экрана нового ключа нет.
   То же для страховочной копии корня администратору (п. 7), созданной вручную на устройстве с корнем: пароль
   аккаунта до записи копии (`storeEscrowCopy(key, password)`, окно режима `escrow`). Смена ключа подписи устройств
   пароль не спрашивает — она идёт и сама при отзыве устройства.

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
`peer_root_changed` (служебное сообщение в чате, `Client.kt`). Ввод ключа восстановления и сброс в UI desktop — окно
«Подтвердите вход» (`parvane_account_ui.cpp` `FillLinking` → `RecoverWithKey`,
`ResetIdentityWithPassword`, spec 029); Android (spec 031) — JNI `nativeRecoverWithKey`
(вход по копии ключей, RECOVER-2), `nativeResetIdentity`; ввод ключа — `AccountController.kt`
оверлея, экрана сброса личности нет.
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
Android JNI (spec 031) `rememberBlobCaps` / `downloadChatBlob` (`jni_main.cpp`) и
`uploadChatBlob` (`jni_messages.cpp`) — все вложения, архивы паков и картинки превью по
секрету, грантов получателям нет. Тесты: ядро `v2_session_tests.cpp` (живой, T131), сторож
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
`PublishNotifyBlob`, `PrivacyLocal.dirty`); Android (spec 031) — `StateJournal.kt` (все виды:
папки, блок-лист, черновики, архив, отложенные, уведомления, закреп, «непрочитано», быстрая
реакция; JVM `StateJournalTest.pinsUnreadAndReactionRoundTrip`), приватность — события
`privacy`/`privacy_saved` → `PrivacyPrefs.kt`. Тесты:
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
`NoteBlock`; Android JNI `nativeRevokeContactAccess` — `Client.kt` зовёт его при блокировке
(spec 031). Тесты: движок `revocation_flow.rs`
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
`V2SetInfo`, `ListJoinRequests`/`DecideJoinRequest`; Android JNI (spec 031, v1-нотисов нет)
`jni_groups.cpp` `nativeGroupSetInfo` (`Session::setGroupInfo`), `nativeGroupRequests`/
`nativeGroupRequestDecide`. Тесты: движок
`client_flow.rs` (`join_request_is_approved_by_add_member`), сторож
`conformance.test.ts` (GROUP-3), сценарии web `web2-groups`
(`e2e_protocol_groups.mjs`: заявка, отказ, одобрение), `group_admin`
(переименование админом), desktop `verify_conformance_group.sh` (п. 3: v1-нотис
к группе v2 не применён), `verify_protocol_v2_invites.sh`, `verify_group_manage.sh`.

4. **Кто видит журнал группы (spec 035, 8 ноя 2026; PV-006, PV-007, A0023-2, D5).** Сервер отдаёт
   `group.state.sync` по матрице `specs/035-protocol-evolution/contracts/group-access.md` (векторы
   `proto/parvane/vectors/group_access/matrix.json`): действующий участник — всё; бывший (вышел, исключён,
   забанен после вступления) — записи до записи своего выхода включительно (`exit_v` последнего окна членства,
   таблица `group_membership_windows`); вступающий по ссылке — ТОЛЬКО с `invite_proof` (подпись ключом ссылки над
   `"parvane/group-invite-sync/v1\0" ‖ domain ‖ "\0" ‖ group_id ‖ user ‖ "\0" ‖ i64be(ts_ms)`, свежесть ±5 мин,
   ссылка действующая) — одного `invite_link_id` мало: его знает и сервер; бывший участник с живой ссылкой без
   доказательства — как бывший; ожидающий одобрения — как вступающий, и без свежего доказательства, пока заявка не
   решена; забаненный посторонний и посторонний — `FORBIDDEN`. Публичная группа (PUBLIC-1) открыта всем, кроме
   забаненных. Доказательство строит движок (`invite::sync_proof`, `Client::group_sync_by_link`), клиенты сами
   подпись не собирают. Тесты: messenger `v2_groups::tests::access_matrix_*` (каждая клетка по векторам),
   `membership_windows_follow_rejoin`; движок `invite::tests::sync_proof_binds_link_group_user_and_time`.
   Живой — `parvane-integration --test v2_group_access_live` (роли `matrix.json` через gateway).
   Клиенты (spec 035, 11 ноя 2026): `invite_proof` подписывает движок — web (`groupSyncByLink` единой точки входа,
   `v2/controller.ts`), desktop и android (общее ядро: `v2_engine.cpp` `Client::groupSyncByLink`, `v2_session.cpp`);
   своей подписи у клиентов нет.
5. **Одно уведомление на группу (spec 035, остаток S7-16).** Неподтверждённое уведомление журнала группы
   (`GroupStateNotice`) в инбоксе устройства замещается следующим той же группы (`inbox_log.group_key`, одна
   транзакция): клиент по уведомлению синкает журнал от своего курсора, номер версии в уведомлении — подсказка.
   Тест: messenger `v2::spent_tests::group_state_notices_replace_unacked_of_same_group`.
6. **Сведения и права — из модели (spec 035, ENGINE-1).** Название, описание, фото, состав, роли, права и ссылки
   группы модель берёт из журнала группы (`GroupFacts::from_state`) и отдаёт `GroupView` (`viewGroup`) и изменением
   `groupChanged`; права композера и меню — `capabilities` (GROUP-2). Своего кэша сведений групп у web больше нет
   (`saveGroupCache` удалён, OPT-016: тест `personalStore.groupCache.test.ts`), фото группы web берёт из
   `GroupView.photo`; desktop и android — сведения движка через ядро (`Client::groupInfo`). ОТКРЫТО: tdesktop и шов
   android не читают `GroupView` напрямую (T126, T136).

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
- кадры инбокса v1, которые сервер перекладывал в инбокс v2 (записи `LegacyV1`:
  история при первом синке и живые кадры), клиент без соединения v1 подавал тем же
  обработчикам инбокса (FR-053) — с T110 сервер их не пишет, с T096 записи и события нет;
- присутствие («в сети») публикуется и эфемерным каналом v2;
- отсутствие v1 — не ошибка: диалога «обновите приложение» нет, цикла
  переподключений v1 нет, запросы переписки v1 (`msg.sync.request`, `group.list`,
  `call.history.request`, публикация прекеев) не шлются;
- текста ошибок в протоколе v2 нет: формулировки для экранов входа клиент
  подставляет сам по запросу и коду.

Сценарии: web — вся матрица (с T110 web без v1 целиком; пара `v1-off` удалена), desktop —
все `desktop/verify_*.sh` (со spec 029 desktop без v1, с T038 — без моста; `verify_protocol_v2_v1off.sh` удалён), android —
все `android/tgx_*_flow.sh` (со spec 031 android без v1 и без моста: соединение управления v2
`parvane::v2::Control` и сессия ядра, как desktop; сценарий `tgx_protocol_v2_flow.sh` с блоком
disabled удалён — выключать нечего).

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
Android — закрыто удалением (spec 031): групп v1 у android нет (каталог прежней версии
стирается при первом запуске), группы — только из журнала v2.

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

**С spec 035 (11 ноя 2026).**
1. **Кодеки из схемы.** Ручные таблицы `encode_message`/`decode_message` (`host.rs`, `wasm/src/lib.rs`) заменены
   сгенерированным `type_codec` по всем сообщениям `proto/parvane/**` (тест `tests/type_codec.rs`); «новое поле —
   во всех обвязках» без ручной правки. Типы модели для клиентов порождает `cargo run -p parvane-protocol --bin
   gen_bindings` (`--check`, тест `tests/bindings_fresh.rs`) — правка сгенерированных файлов руками запрещена.
2. **Версии.** `PROTO_MINOR_035` (`backend/protocol/src/limits.rs`); gateway и federation отказывают ниже минимума
   (`UPGRADE_REQUIRED` и закрытие; `PARVANE_V2_MIN_MINOR` в compose, `scripts/run_web_e2e.sh`, `desktop/verify_lib.sh`,
   `android/tgx_lib.sh`; живой `v2_min_minor_live`). Клиент показывает «обновите приложение» сам: web — экран пароля и
   диалог «данные от более новой версии» (`MODEL_TOO_NEW`, тест `modelOpen.test.ts`), desktop — строки tdesktop
   `lng_parvane_upgrade_required`, `lng_parvane_write_blocked`, `lng_parvane_stub_critical` (T128), android —
   `SeamText.kt` (`upgrade_required`, `too_new`, `stub_critical`). `engineInfo()` (`pv_engine_info`,
   `<шард> --engine-info`, тест `tests/engine_info.rs`) отдаёт версию API модели, минор, форматы хранения и хеши
   исходников и схемы — по ним манифест выпуска сверяет артефакты (`scripts/make_release_manifest.sh`,
   `scripts/verify_release_manifest.sh`; прогон по всем артефактам — T144).
3. **Неизвестное** — заглушка `STUB`/`STUB_CRITICAL` и `writeBlocked` журнала (CONTENT-1, STATE-1); подписанное
   (журнал устройств, журнал группы, `SignedOp` доменов) хранится и отдаётся исходными байтами
   (`tests/signed_raw.rs`), без пересборки.
4. **Смысл — тоже движок** (ENGINE-1 ниже): правило PROTO-1 запрещало клиентам разбор байтов, ENGINE-1 — ещё и
   собственное толкование разобранного.

## ENGINE-1. Смысл решает движок (spec 035, 11 ноя 2026)

**Spec 035, FR-095, FR-096, SC-005; принцип V.** Разбор содержимого, сведение личного состояния и истории, права
групп каждый из трёх клиентов делал по-своему, и точечные правки в трёх местах не раз расходились (история этого
файла, spec 033). С spec 035 смысл живёт в одном месте — модели движка `backend/protocol/src/model/` (схема `proto/parvane/engine/v1/model.proto`,
контракт `specs/035-protocol-evolution/contracts/engine-api.md`):

- **содержимое** — `MessageView` (`model/views.rs`: `content_view` / `contentOfWire`, выбор показа по `features`
  — `model/features.rs`); в клиенте нет `switch` по видам содержимого и своих перекладок;
- **личное состояние** — журнал `state.v2`, сведение по полям только в движке (`state2.rs`, показ и правка по видам —
  `model/state_json.rs`; STATE-1); в клиенте нет лампортов, меток, сравнения меток, прежнего `state.append`;
- **строки истории** — модель (`model/host_rows.rs`: `rowsApply`/`rowsAll`, страницы `historyPage`/`chatList`,
  `model/paging.rs`; HIST-1);
- **группы** — `GroupView` и `Capabilities` (`model/capabilities.rs`: `GroupFacts`, `hides`, `capabilities`;
  GROUP-2, GROUP-3); в клиенте нет формулы прав по типу содержимого;
- **журналы** — состояние записи и `writeBlocked` (`model/journal.rs`, CONTENT-1);
- **клиентское ядро** — в модели (`model/client_core.rs`): режим хоста `host_driven`, вызовы `clientCall`/`historyCall`
  единой точки входа (`backend/protocol/src/host/call.rs`), записи инбокса — `ingest`, нужды — `needs` + `retry`/`skip`.

Хост вызывает модель из одного места и исполняет её итог (`Outcome`): пачку хранилища фиксирует ДО запросов того же
итога, затем `storeCommitted`; ответы сервера на запросы модели подаёт `ingest`. Web — `v2/engine.ts` (`ModelHost`,
хранилище `v2/storeIdb.ts`), desktop и android — хост ядра `desktop/parvane-core/src/engine_host.cpp` (хранилище
`store_fs.cpp`; android — `android/jni/model_jni.cpp` поверх него). Векторы модели `proto/parvane/vectors/model/*.json`
(ожидания руками) прогоняют движок `tests/model_vectors.rs`, web `modelVectors.test.ts` (WASM), ядро
`model_vectors_tests.cpp` (desktop и android), android `ModelVectorsTest.kt` (JNI).

Сторож — `web/telegram-tt/src/api/parvane/conformance.test.ts`, блоки `describe('ENGINE-1 …')` для web, desktop и
android: grep по исходникам клиента, что разбора, сведения и прав вне модели нет и модель зовётся только из хоста.
Пункты `it.fails` — то, что в клиенте ещё не переведено (пока старый путь на месте, они «проходят»; после перевода
vitest требует снять `.fails`).

**Состояние на 13 ноя 2026 (spec 036, T039): правило ЗАКРЫТО во всех трёх клиентах** — в блоках ENGINE-1 web, desktop
и android сторожа `it.fails` нет, полные серии и смешанные пары прошли на модели.
- **web** — строки и журнал истории аккаунта (вход по точке, замена, откат), маркеры и непрочитанное (`unread_changed`),
  список чатов (`chatList`/`chat_upsert`), личное состояние по видам (`viewStateJson`/`stateSet`/`stateMark`,
  `v2/stateObjects.ts`), группы (`viewGroup`, права себя `GroupView.can_*`) — из модели (`engine_rows: true`).
  Вне модели осознанно: самоуничтожение собеседника (память показа), шифртекст v1, черновики/очередь отложенных с
  параметрами медиа, секреты наборов (C7-3); `toWireGroupInfo` — раскладка готового `GroupView.info_json` в форму слоя
  групп tt (своего сведения, версии и прав в ней нет; T020 — оставлено осознанно).
- **desktop** — то же ядро, что android: `SessionConfig.engineRows` + `modelEvents`, строки — `ModelRows` (`viewOfModel`,
  `allViews`), прочтение — намерение `read` (`Session::readTo`), личное состояние — `StateModel` поверх `viewStateJson`/
  `stateSet`/`stateMark` (мост `state.v1` удалён, T038), группы — `viewGroup`; tdesktop показывает `MessageView`
  (`StoredFromView`, `ShowModelRows`). С 13 ноя (вечер, T030/T031): список диалогов — из `chatList` модели
  (`ShowModelChats`: место `ChatView.order`, закреп, архив, отметка, мут, последняя строка, `chat_remove`); файлы
  `tdata/parvane-*` — записи хранилища движка (`PathFiles` в tdata: `parvane-host`, `-account`, `-device`; каталог
  состояния — `Session::*StateFileIn`), storecrypt — читатель переноса и кэш медиа.
- **android** — то же ядро (`jni_session.cpp`: `cfg.engineRows`, `cfg.modelEvents`), `jni_history.cpp` показывает
  строки модели в её порядке, прочтение — намерение `read`, `StateJournal.kt` — объекты модели по видам. С 13 ноя
  (вечер, T035/T036): лента X — страницами модели (`GetChatHistory` → `historyPage`, id сообщения по месту ленты —
  `MessageIds`), список чатов — видом модели (`chat_list`/`chat_views`); служебные файлы — хранилище движка (PathFiles,
  каталог состояния); storecrypt — читатель переноса и кэш медиа. Группа без сообщений стоит в `chatList` временем
  появления в списке (движок, `Meta.chats_since`).

Серии 13 ноя 2026 (MSI): движок `cargo test -p parvane-protocol` 449/449, ctest ядра 75/75, живой
`run_v2_session_live.sh` 220/220, desktop `verify_*` 68/68 (`d036f` 67/68 + повтор `d036g`), web vitest 2898/2898 и
web-e2e 93/93 (`e036f` 87/93 + повторы `e036g`), пары web2-desktop2, state-sync, state-sync-desktop,
state-patch-desktop, revoke, sections-desktop — зелёные (`m036f-*`), android JVM 172/172 и 26/26 сценариев (`a036f` 25/26 +
`tgx_pack_set_flow` после правок — `a036i`). Логи — `local-workdirs/spec035/msi/lanes/`, `local-workdirs/spec031/logs/`.

## Векторы v2 — указатель (T088)

Все правила, которые переносятся на протокол v2, проверяются по векторам
`proto/parvane/vectors/**` (индекс — `proto/parvane/vectors/conformance/README.md`):
кадры и лимиты — `codec/`; подписи — `sign/`; журналы устройств (KEY-1 v2,
LINK-1) — `device_log/`; журнал группы (GROUP-1, GROUP-2 права) —
`group_log/`; конверты (SEAL-1, GSEAL-1) — `seal/`; личное состояние
(STATE-1) — `state/`; ссылки-приглашения — `invite/` (v1-история `legacy_v1/` удалена, T096);
права по типу содержимого — `content_guard/`; виды содержимого (CONTENT-1) —
`content/`; режим «усиленная приватность» (L2-1) — `l2/`. С spec 035: личное состояние v2 (STATE-1) — `state2/`,
модель движка (ENGINE-1) — `model/`, матрица доступа к журналу группы (GROUP-3) — `group_access/`, непонятое —
`unknown/`, хранилище движка — `storage/`.

## Обязательный сценарий: устройство отсутствовало

Все e2e гоняются на чистом стеке, где оба клиента онлайн и устройства уже в
каталоге. Случай «отправили, пока второго устройства не было» не проверялся
никогда — именно он и ломался. Сценарий обязан быть в каждом клиенте:

- desktop: `desktop/verify_offline_device.sh`
- web: `scripts/run_web_offline_device_e2e.sh`
- android: `android/tgx_conformance_flow.sh`, шаг 1 (X остановлен, bob-desktop
  шлёт три сообщения, X запущен → все три показаны, курсор в `cursors.json`
  сдвинут только за применённое; 27 сен 2026)

**Spec 035 (T142, US1 п. 3): устройство обновилось через месяц после остальных** — проверялось сценариями разового
переноса (web `run_web_migration_e2e.sh month`, desktop `verify_migration.sh month`, android `tgx_migration_flow.sh`,
сверка `migration_month_check.py`) до 12 ноя 2026; удалены вместе с кодом переноса (T149). Общий инструмент
«плановые чистки как через N суток» — `messenger --gc-as-of <unix-секунды>` — остался.

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
4. **Чужой домен.** Клиент, не реализующий домен (desktop и android реализуют его со spec 029 и
   spec 031 — раздел «План» поверх `PlannerSync` ядра),
   принимает `container_key` и операции незнакомого домена без ошибок и без
   влияния на остальную синхронизацию (движок хранит ключ, UI не трогает).
5. **Сведение** — в движке (`domain/planner.rs`): «последняя правка
   побеждает» по полям объекта, надгробия, метки `(lamport, device_id)` +
   байты изменения; снимок каждые 200 операций; потолки каркаса (операция
   256 КБ, снимок 1 МБ).
6. **С 17 ноя 2026 (spec 041 B4)** здоровья, питания и целей питания в `planner.v1` нет — они в домене
   `parvane.health.v1`: сообщения удалены, номера полей `Change` 4, 6, 8, 9 и `PlannerSnapshot` 4, 6, 7, 8
   зарезервированы, изменения `nutritionDay`/`goals`/`goalPeriod`/`health` движок отвергает как неизвестный вид.

Реализации: движок `client_planner.rs`, `domain/planner.rs`,
`domain/planner_json.rs`; шард `domains` (`key.rotate`, `container.list`);
web `v2/personalSync.ts` (вид — `planner.ts`), `controller.ts`, `provider.ts`, `plannerSync.ts`,
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
3. **Клиент без планировщика** (так было у desktop и android до spec 029 / spec 031; теперь оба
   показывают карточку с кнопками) показывает поле `text`
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
android `ParvaneStore.kt` (`contentFrom` → `MessageText`), с spec 031 — карточка с кнопками
(`Cards.kt`, нажатие `GetCallbackQueryAnswer` → «План» ядра). Тесты: web
`taskOffers.test.ts`, `protocol.vectors.test.ts`, сторож `conformance.test.ts`,
сценарий `scripts/e2e_web_task_offer.mjs`; desktop `tests/v2_tests.cpp`;
android `ProtocolV2SeamTest.kt`, `CardsTest.kt`.

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
9. **Граница эпохи** (A0006-1): запись `revoke`/`rotate` несёт `Grant.epoch_boundary_seq` — голову журнала операций,
   принятую автором. Операция и снимок (по `upto_seq`) эпохи, прежней относительно такой записи, с seq выше границы
   отвергаются движком (`Forbidden`), даже если автор был редактором той эпохи. Нет поля (старые записи и клиенты) —
   проверки нет. Код общий (`domain.rs`), правки клиентов не нужны; тест — `planner_domain`/`cloud_domain`
   `epoch_boundary_rejects_old_epoch_after_cut`. То же правило действует в домене `planner.v1` (DOMAIN-1).
   **Граница по подписанным данным** (S7-6, 7 ноя 2026): вместе с `epoch_boundary_seq` запись несёт
   `Grant.epoch_boundary_op_id` — op_id операции на месте границы у автора записи (seq ставит сервер, op_id подписан
   автором операции). Читатель держит операции прежних эпох до границы (`EpochCut.held`, в персисте `held_ops`),
   пока на месте границы не окажется операция с этим op_id; другая операция на этом месте или эта операция на
   другом месте — сдвиг журнала сервером: удержанное не применяется, `last_error = ContextMismatch`. Пустой op_id
   (на месте границы у автора был снимок; старые записи) — граница только по seq. Остаток: подмену одной операции
   другой с удержанием законной сервер по-прежнему может сделать незаметно для нового читателя; снимок прежней
   эпохи с `upto_seq` ≤ границы op_id не заверяет. Код общий (`domain.rs`, `client_cloud.rs`, `client_planner.rs`);
   тест — `client_flow::cloud_epoch_boundary_detects_shifted_log`.

   **Обрезка журнала снимком** (spec 035, 8 ноя 2026; S7-22, FR-032, FR-077). Снимок несёт `Snapshot.complete`
   (входит в подписанный автором `SealDigest.complete`): составитель понимает весь диапазон `≤ upto_seq` — ничего не
   отложено без ключа, не удержано до границы эпохи и каждая операция разобрана целиком (`unknown::scan` без находок;
   после восстановления из персиста до следующего снимка — `complete = false`). Шард `domains`, приняв такой снимок,
   удаляет операции `seq ≤ upto_seq`, уменьшает квоты контейнера и писателей и отвечает на синк полем
   `DomainOpSyncResponse.truncated_upto`; курсор меньше границы — пустая страница: клиент берёт снимок
   (`domain.snapshot.get`) и продолжает с его `upto_seq` (`PlannerIngest.need_snapshot`, `CloudIngest.need_snapshot`).
   Снимок без `complete` журнал не трогает; потолок операций контейнера считает живые операции. Код общий (движок
   `domain.rs` `seal_snapshot_complete`, `client_planner.rs`, `client_cloud.rs`); тесты — шард
   `domains::tests::truncate_after_complete_snapshot`, движок `client_flow::planner_truncated_cursor_takes_snapshot`.
   С spec 035 (11 ноя 2026) условие `complete` учитывает отметки `range-hold` журнала контейнера (`hold::note`,
   `domain::hold_journal`): снимок не заменяет и не обрезает то, чего составитель не понял (тесты
   `tests/compat_circle.rs`, `tests/range_hold.rs`). ОТКРЫТО: хосты web (`v2/personalSync.ts`, `v2/cloud.ts`) и ядра
   (`sections/planner_sync.cpp`, `sections/cloud_sync.cpp`) берут снимок только при пустом курсоре, а по
   `need_snapshot` (курсор внутри обрезанного) — нет: курсор такого устройства стоит. Домены в модель движка ещё не
   переведены: намерение `IntentDomainOp` в `model.proto` есть, но клиенты зовут вызовы `planner*`/`cloud*`
   клиентского ядра (через `clientCall`) и сами ведут синк контейнеров.

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
   (ID-канал). Desktop и android этих методов не вызывают и ссылок не показывают (раздел «Облако» у них есть
   со spec 029 / spec 031).
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

**Spec 024 (17 окт 2026): web — сделано, desktop — со spec 029, android — со spec 031.**
`Content.mod_report = 24` — видимое личное сообщение каждому админу группы с правом удалять сообщения или банить:
`group` (группа), `messages` (≤ 20: `op_id`, автор, текст, время), `reason` — код причины (`spam`, `violence`,
`porn`, `child`, `copyright`, `illegal`, `personal`, `fake`, `other`), `comment` (≤ 1024), `text` (≤ 600) —
представление для клиентов без модерации. Web показывает карточку с «Удалить сообщения» (мутация удаления в группе
от админа) и «Заблокировать в группе» (запись `Ban` журнала группы). Клиент без модерации обязан показать `text`
обычным текстом и не падать.
**Подпись автора (A0008-2, 30 окт 2026).** `ReportedMessage.proof = 5` — `core.v2.MessageProof`: исходная подписанная
операция автора (`SignedOp`) и сертификат его устройства (цепочка корень → SSK → устройство, самодостаточна). Движок
кладёт её в событие `direct`/`group` (поле `proof`, base64, ≤ 16 КиБ), клиент ХРАНИТ рядом с полученным сообщением (web —
`WireStoredMessage.proof`, desktop — `StoredMessage.proof`, android — `MsgRow.proof` + журнал) и прикладывает к жалобе
(админам группы и серверу; суммарно ≤ 100 КиБ base64, иначе без подписей). Проверка — `verifyMessageProof` движка
(автор = владелец сертификата, подпись верна, `op_id` и начало текста совпадают, для жалобы группы — контекст беседы
именно этой группы). Получатель: сообщение из своей истории — как раньше (автор и текст свои); сообщения нет в истории —
принимается только с верной подписью автора-участника группы (карточка помечает «Автор подтверждён подписью»), без неё
или с неверной — отбрасывается, действия карточки к нему не применяются. Администратор сервера: `escrow_admin open-report`
печатает по каждому сообщению «подтверждено подписью устройства …, корень …» либо «НЕ ПОДТВЕРЖДЕНО»; соответствие
корня адресу автора сверяется с журналом устройств на сервере. Правка текста после получения подпись не ломает, но
текст в жалобе перестанет совпадать с подписанным — такое сообщение тоже «не подтверждено».

Жалоба администратору сервера — не содержимое переписки: метод `identity.report.submit`, шифртекст под ключом
`ServerDescribeResponse.report_public_key` (HPKE, `info = "parvane/v2/report\0" ‖ адрес автора`), клиентам без
этой функции делать ничего не нужно.

Desktop (spec 029): ядро `v2_content.cpp` (`mod_report` ↔ v2), `messenger.h` (`contentText`),
`v2_session_account.cpp` (`submitReport`); tdesktop `parvane_client.cpp` (`ReportMessages` из штатного окна
`api_report.cpp`, карточка админа `CardMarkup` → `HandleCardButton` `pv:moddel`/`pv:modban`); тест
`tests/v2_tests.cpp` («mod_report туда и обратно», «карточка mod_report показывается текстом»).

Android (spec 031): `Client.kt` `reportChat` (штатное окно жалобы X: причина → комментарий → карточкой админам
группы либо администратору сервера `nativeSubmitReport` → `Session::submitReport`), карточка админа с кнопками —
после проверки своими данными (`nativeCheckModReport` → `validateModReport` ядра, `Cards.kt`), без проверки — `text`;
тест `CardsTest.modReportOnlyWhenCheckedAndArticleAlways`. Сценария эмулятора нет.

## RENAME-1. Смена ника

**Spec 026 (17 окт 2026): web — сделано, desktop — со spec 029, android — со spec 031.**
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

Android (spec 031): `android/jni/jni_account.cpp` `nativeRenameAccount` (`Session::renameAccount`; каталог состояния
и журнал истории переезжают под новый адрес), событие `peerRenamed` → `ParvaneStore.noteRename` (тот же чат) и
служебное сообщение; экран — `AccountController.kt` оверлея. Сценария эмулятора нет.

## DELETE-1. Удаление аккаунта

**Spec 027 (17 окт 2026): web — сделано, desktop — со spec 029, android — со spec 031.**
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

Android (spec 031): `nativeDeleteAccount` (`Session::deleteAccount`), вход — `nativeLogin` с `deletion_at_ms`;
`Client.kt` сразу повторяет вход с `cancel_deletion` (отдельного вопроса с датой нет — отступление от п. 1);
удалённый собеседник — событие `peerDeleted` / `nativeCheckPeerDeleted` → `ParvaneStore.markDeleted`. Экран —
`AccountController.kt` оверлея. Сценария эмулятора нет.

## ORDER-1. Порядок сообщений в ленте

**Spec 012 (9 окт 2026): web — сделано, desktop — со spec 029, android — со spec 031 (оба — порядок прихода).**
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

Android (spec 031): как desktop — id сообщения выдаёт шов по порядку прихода (`ParvaneStore.putMessage`,
`nextMessageId`), журнал истории (spec 033: `android/jni/jni_history.cpp historyRows` — строки хранилища RowState)
воспроизводится в порядке id; только строка старше показанных больше чем на окно 300 с встаёт по времени
(`placeByTime`, без сортировки).

## RECOVER-2. Новое устройство по ключу восстановления — без других устройств

**Spec 015 (10 окт 2026): web — сделано, desktop — со spec 029, android — со spec 031.**
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
   base64), `planner` (ключи контейнера), `cloud`, `groups`, `seq`. **С spec 033 поля `history` (снимок истории
   блобом в cloud, «больший снимок победил») нет**: не пишется, не читается и при слиянии копии не переносится —
   история нового устройства приходит из журнала истории аккаунта (HIST-1, HIST-2, READ-2).
2. **Ключ копии** устройство получает, пока ключ восстановления в руках (создание
   и сброс личности, ввод ключа), хранит у себя и передаёт привязанным устройствам
   полем `bk` материала гранта. Сам ключ восстановления устройство не хранит.
3. **Копию пишет** устройство, держащее ключ копии и ключ подписи устройств: после
   запуска, раз в минуту при изменении содержимого, при появлении нового своего
   устройства (истории в копии нет — spec 033).
4. **Вход по ключу**: ключ проверяется копией корня; копия ключей открывается,
   журнал устройств в материале заменяется свежим ответом `identity.device.log_sync`
   (подлинность — ключ подписи устройств из копии обязан совпасть с журналом),
   устройство вступает в журнал тем же запросом, что при привязке. Прежние
   устройства остаются. Нет копии ключей (аккаунт создан раньше) — путь RECOVER-1.
   **Откат сервером (A0073-2):** в зашифрованное содержимое копии пишется монотонный номер записи `seq`
   (целое > 0; нет поля — 0, копия старого формата, формат совместим). Записывающее устройство ставит
   `max(виденный им, серверный) + 1`; каждое устройство хранит наибольший виденный номер и НЕ принимает копию
   с меньшим (при входе по ключу — отказ без «восстановления корнем», при перечитывании и слиянии копия
   игнорируется, следующая запись исправляет сервер). Отпечаток «копия не менялась» считается без `seq`.
   Новое устройство без виденного номера откат первой копии заметить не может. Web — `v2/keyBundle.ts`
   (`isBundleRolledBack`), desktop/android — `keybundle::seqOf`/`isRolledBack` + `Session::acceptBundleLocked`.
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
7. **Ответ достаётся только тому устройству, чей запрос он закрывает** (A0023-1, 30 окт 2026).
   Новое устройство шлёт в `tg_request` эфемерный открытый ключ X25519 (`eph_public`; пару создаёт
   движок: `recoveryTgKeypair`) и получает от сервера код сверки (`RecoveryTgRequestResponse.code`,
   6 цифр) — его показывает экран «Устройства», и тот же код стоит в сообщении бота. Запросов на
   аккаунт до трёх, по одному на устройство: чужой запрос не замещает и не гасит прежний. Бот
   возвращает номер запроса (`TelegramOutMessage.request_id` → `TelegramReplyRequest.request_id`) того
   сообщения, на которое ответил владелец (при нескольких живых запросах — только ответом-цитатой).
   Сервер проверяет ключ по копии корня и отдаёт `tg_poll` только запечатанный ответ
   (`sealed_key`, HPKE на `eph_public`, `parvane_protocol::recovery_tg`); устройство открывает его
   приватным ключом (`recoveryTgOpen`). Владелец присылает ключ, только если код в сообщении бота совпал
   с кодом на экране.
8. **Запрос привязан к сессии, а не к `device_id`** (S7-1, ревью 7 ноя 2026). Вошедший паролем с
   `device_id` нового устройства мог заменить его запрос своим `eph_public` (новый код, новое сообщение бота;
   экран устройства брал новый код из опроса) и получить ответ владельца. Теперь: `eph_public` обязателен
   (ровно 32 байта, иначе `INVALID`; ответа открытым текстом запросившему нет); запрос и опрос — только от
   сессии (SHA-256 JWT; у каждого входа свой `jti`), заведшей запрос; другая сессия с тем же `device_id` и
   другим ключом — `FORBIDDEN`, замены нет, её опрос пуст. Тот же ключ из новой сессии (тот же процесс вошёл
   заново) переносит запрос, код прежний. Смена пароля снимает все запросы аккаунта (S7-10). Офферы привязки
   (`identity.link.poll`) с `device_id` других устройств видят только устройства журнала. **Клиент** не
   заменяет показанный код кодом из `tg_poll` (берёт его, только если своего нет); другой код или `FORBIDDEN`
   на `tg_request` — состояние «запрос перехвачен», ответа не ждать (web `v2/telegramCode.ts`
   `isTelegramCodeIntercepted`, ядро `parvane::v2::telegramCodeIntercepted` для desktop и android).

Реализация п. 7: движок `protocol/src/recovery_tg.rs` (+ `recoveryTgKeypair`/`recoveryTgOpen` в WASM и
`call_static`), сервер `recovery_tg.rs`/`v2.rs`, бот `parvane_tg_bot.py` (`remember_ask`, `resolve_ask`), web
`controller.ts` (`requestTelegramKey`, `pollTelegramKey`, `getTelegramCode`), desktop ядро
`v2_session_account.cpp` (`tgEphSecret_`, `telegramCode`), экран `parvane_account_ui.cpp`, android
`jni_account.cpp` (событие `recovery` с `code`), `Client.kt`, `SeamText.kt`.

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

Реализация android (spec 031): то же ядро; `android/jni/jni_account.cpp` (`nativeTelegramRecovery` —
`requestTelegramKey` → `pollTelegramKey` → `joinWithRecoveryKey`, `nativeRecoverWithKey`, `syncFromKeyBundle` /
`completeKeyJoin` — ключи разделов и группы из копии, история — журнал истории (spec 033), `nativeSendKeyToTelegram`); `Client.kt` по
`needs_linking` сам просит ключ у бота; ввод ключа — `AccountController.kt`. Сценария эмулятора с ботом нет.

## HIST-1. Удалённое не воскресает; событие раньше сообщения применяется (spec 033, 30 окт 2026)

Журнал истории аккаунта (`history.*`, шард messenger; схема `proto/parvane/history/v1`) — общий для своих
устройств источник прошлого. Запись — AEAD на ключе истории = HKDF-SHA256(ключ личного состояния,
`parvane/history/v1`, адрес); сервер видит шифртекст, `seq`, размер, флаг `chunk`. Модель строки и сведение —
только движок (`historyApply`/`historyMerge`/`historyView`, `specs/033-history-sync/contracts/engine-api.md`).

1. **Строка = сведённое состояние** (`RowState`): каждое событие (приём, отправка, своё действие, запись журнала,
   сегмент точки) — `historyApply` к хранимой строке; показ — `historyView`. Итог не зависит от порядка и повторов.
2. **Удалённое — надгробие навсегда** (до горизонта HIST-2): строка остаётся в хранилище без содержимого и не
   показывается; ни журнал, ни точка, ни перезапуск, ни вход нового устройства её не возвращают.
3. **Событие раньше сообщения** (удаление, правка, реакция, закреп) — сирота: сохраняется и применяется, когда
   сообщение придёт (инбоксом или журналом, в любом порядке); удалённое до прихода не появляется вовсе.
4. **Удаление**: «у всех» — по выбору пользователя (личный чат — любое сообщение, в том числе собеседника; группа —
   своё либо админу с правом удалять) — мутация v2 собеседнику и своим + запись журнала; «только у меня» — ТОЛЬКО
   запись журнала (`GONE_SCOPE_ME`), собеседник ничего не получает. Получатель проверяет право `historyCanDelete`
   (то же правило — движок `mutation_authorized`); прежнее «удалить может только автор» снято.
   Автор мутации едет в самой операции журнала: `Edit.by`, `Gone.by`, `Gone.by_admin` (пусто — своё). Движок
   сверяет их с автором строки и тогда, когда мутация пришла РАНЬШЕ строки (новое устройство: инбокс раньше
   журнала): до прихода строки правки и удаления — кандидаты (`RowState.pending_edits/pending_gones`), победитель —
   только среди действительных. Подменить текст чужого сообщения правкой, пришедшей раньше него, нельзя.
5. **Кто пишет** (ревью 7 ноя 2026, S7-3): своё отправленное, свои действия, маркеры и входящее — ОДНОЙ пачкой
   через случайные 30–120 с после первого события в очереди (`batchDelayMs`); входящее — только если этой операции
   ещё нет в журнале (id строки, метка мутации; перед записью — догон журнала). Прежние раздельные сроки («своё
   ≤ 300 мс, входящее 1–5 с») сняты: по времени записи сервер отличал автора личного сообщения и автора в группе от
   получателей (обход sealed sender и скрытого автора). Открытый текст записи выровнен движком по сетке L2
   (`HistoryBatch.padding`, `seal::l2_padding_len`) — размер записи не выдаёт сообщение; сервер хранит время записи
   с точностью до суток (миграция messenger `0006_history_at_day`). Своим устройствам сообщение приходит сразу
   копией; несданная очередь — на диске и уходит новой пачкой после перезапуска. Запечатанные тела повторяются как
   есть (номер цепочки писателя, HIST-2 п. 5). Сценарии стенда сужают окно: web — диаг-сборка
   (`VITE_PARVANE_DIAG_HOOKS=1`, 1–3 с или `localStorage['parvane:e2e:historyBatchMs']`), desktop —
   `PARVANE_HISTORY_BATCH_MS` в dev-сборке со стендом на loopback (`verify_lib.sh` — 1000,3000), android — debug-APK
   (1–3 с или `/data/local/tmp/parvane-history-batch-ms`). Отправка и приём записи в журнал не ждут.
   `JournalNotice{HISTORY}` в инбоксе — сразу `history.sync`; опрос — раз в 60 с.
   `JournalNotice{STATE}` — сразу синк журнала личного состояния (опрос state — 60 с вместо 8 с).
6. **Перенос** (FR-024): каждое обновлённое устройство один раз пишет в журнал всю локальную историю как
   `RowState` (с известными правками/реакциями/закрепами) и маркеры по прежнему учёту прочитанного. Снимок истории
   в копии ключей аккаунта и история в экспорте привязки удалены (RECOVER-2 п. 1, LINK-1 п. 8).
7. Самоуничтожающиеся и нерасшифрованные сообщения в журнал не пишутся; очистка чата (`ChatCleared`) отсекает строки
   и в точке.

Web: `v2/historyModel.ts` (перекладка строки ↔ JSON движка), `historyRows.ts` (строки — модель; свои операции и
маркеры — `rowsApply` с `journal: true`), `v2/controller.ts applyEvent` (события вне итога модели и мутации строк
самоуничтожения собеседника в памяти → операции), `messages.ts deleteMessages` (область по выбору). С spec 036 T017
очередь журнала (S7-3: одна пачка 30–120 с), синк, живое уведомление и опрос ведёт модель движка
(`backend/protocol/src/model/mod.rs`, `engine_rows: true`); `v2/history.ts` удалён. Тесты `historyRows.test.ts`,
векторы `history/*` в `protocol.vectors.test.ts`, сторож `conformance.test.ts` (web делегирует журнал модели);
сценарий `scripts/run_web_history_sync_e2e.sh`.

Desktop (общее с android ядро): `desktop/parvane-core/src/history_sync.cpp` (`parvane::history::HistorySync` — очередь
одной пачкой 30–120 с с проверкой «уже в журнале», запечатанные тела на диске, `JournalNotice`, опрос 60 с, перенос один раз;
строки — модель движка через `ModelRows`, с spec 035 T125, см. абзац ниже); клиент — `parvane_client_history.cpp`
(разовый перенос прежнего `tdata/parvane-history-<адрес>.jsonl`, журнала StoredMessage и `parvane-read.txt` в
модель), `parvane_client.cpp` (`ApplyIncomingMutation` —
Delete/Edit/Reaction/Pin операциями журнала, права `historyCanDelete`; `MirrorDelete` — «у всех» по праву движка,
«только у меня» — только журнал; `ReplayHistory` — из строк, надгробия не показываются); `history_item.cpp`
`canDeleteForEveryone` — в личном чате и сообщение собеседника, без срока. Тесты — `parvane_history_sync_tests`
(поддельный сервер журнала), векторы `history/*` в `parvane_protocol_vectors_tests`; сценарий
`desktop/verify_history_sync.sh`.

Android (то же ядро, `history_sync.cpp` в `android/jni/CMakeLists.txt`): `android/jni/jni_history.cpp` — строки в модели
движка (`ModelRows` ядра, spec 035 T125; прежние `history-<адрес>.jsonl` — в модель один раз), прежний журнал событий
`journal.jsonl` переносится в строки модели один раз (`convertLegacyJournal`); события шва
строятся из строк (`showStates`: новое — `message`, правка — `edited`, реакции и закреп — `meta`, надгробие —
`deleted`; удалённое раньше прихода не показывается); `historyApplyIncomingMutation` — Delete/Edit/Reaction/Pin
операциями с автором (`by`/`by_admin`, права — движок), неизвестная цель — сирота; `jni_messages.cpp nativeDelete` —
«у всех» по `historyCanDelete` (мутация v2 + надгробие EVERYONE), «только у меня» — только надгробие ME; свои правка,
реакция, закреп — операции журнала с `op_id` мутации. Окно удаления X: `Client.kt messageProperties` →
`ParvaneStore.canDeleteForEveryone` (личный чат — и чужое). Тест — `libtd ParvaneStoreHistoryTest`; сценарий —
`android/tgx_history_sync_flow.sh`.

**С spec 035 (11 ноя 2026) — строки истории в модели движка.** Сведение строки (`history::apply`, пп. 1–4), место в
ленте (ORDER-1), маркеры «прочитано до» (READ-2) и хранение строк (виды хранилища `history-row`, `history-mark`) —
модель (`backend/protocol/src/model/host_rows.rs`); показ — `MessageView`, страницы `historyPage`/`chatList`
(`model/paging.rs`: 20 000 строк страницами по 50 в обе стороны без пропусков и повторов — `tests/model_paging.rs`),
удалённое — изменение `messageRemove`, надгробие хранит модель. Хост в режиме `host_driven` отдаёт модели все операции
над строками (своё, входящее, записи журнала, квитанции, удаление у себя) вызовом `rowsApply`; тесты
`tests/model_rows.rs`, вектор `proto/parvane/vectors/model/history_paging.json`, `edit_before_row.json`,
`delete_everyone_direct.json`, `delete_me.json`. Web перешёл (T114): `historyRows.ts` своей копии строк не держит
(в памяти — индекс показанного), `fetchMessages` — страницами модели (`provider.ts`), чаты со строками — `chatList`;
журнал истории аккаунта (очередь, синк, точки) с spec 036 T017 ведёт модель (`v2/history.ts` удалён). Desktop и android (общее ядро,
T125): строки — модель через `ModelRows` (`history_sync.cpp`: `rowsApply`, `rowsAll` с выборкой по чату и id, счётчик
чата — `rowsRead`; модель — та же, что у сессии v2, без сети — по прошлому открытию `Session::openModelOffline`);
своего хранилища строк и сведения строк и маркеров у ядра нет, права чужой мутации до строки — модель (поле `by`).
Прежние файлы строк (spec 033) и журналы до spec 033 (desktop StoredMessage, android `journal.jsonl`) переносятся в
модель один раз (`importLegacyRows`, `ConvertLegacyOps`, `convertLegacyJournal`; отметка — служебный документ
`imported`, сами файлы не удаляются). Сессия журнала — `historyCall` модели; показ tdesktop — из RowState модели
(`historyView`), не из `MessageView`.

## HIST-2. Контрольная точка, горизонт надгробий, откат сервера (spec 033)

1. **Точка** — записи самого журнала с `chunk = true`: сегменты (`RowState` всех чатов за месяц, ключ
   `historySegmentKey` = `m|ГГГГ-ММ`, при крупном — части `#n`; до ревью 7 ноя 2026 — чат за месяц, такие сегменты
   прежних точек читаются как раньше, S7-5: по числу сегментов сервер не узнаёт число чатов) и сводка (`historySummary`: по чату — последняя строка, маркер,
   непрочитанные, число строк; список сегментов с отпечатками), затем `history.checkpoint.commit` (CAS по номеру
   прежней точки). Строит устройство с курсором у головы, когда записей после точки > 5000 или точке > 24 ч
   (первая — по числу записей), со случайной задержкой 0–60 с; перед фиксацией сверяется, что журнал не дописан во
   время сборки. Сегмент с тем же отпечатком (и не `stale`) переходит в новую точку прежним `seq`. Отказ CAS
   (`DUPLICATE`) — точку не повторять, пока не появится новая. После смены ключа личного состояния этим устройством
   — принудительная точка с перезаливкой всех сегментов (иначе новое устройство не прочтёт старые записи).
2. **Новое устройство** (любой путь входа): `history.head` → сводка (список чатов и маркеры сразу) → сегменты,
   свежие месяцы первыми → `history.sync(after = upto, skip_chunks)`; инбокс — в любом порядке.
3. **Горизонт 180 дней**: надгробия и сироты старше выбрасываются при сборке точки (`historyCompact`), сводка несёт
   `tombstones_since_ms`. `compacted` в ответе синка → `historyNeedsReplace` (устройство не синхронизировалось
   дольше горизонта): замена локальной истории точкой, иначе сведение.
4. **Откат сервера**: голова журнала меньше уже виденной — журнал не применяется, предупреждение в журнал
   диагностики.
5. **Подмена точки и пропуск записей** (ревью 7 ноя 2026, S7-4; векторы `history/checkpoint.json`, набор
   `history/checkpoint`). Номер записи (`seq`) назначает сервер ПОСЛЕ шифрования, поэтому в AAD его положить нельзя;
   вместо этого то, что сервер мог бы подменить, названо внутри шифра:
   - сводка несёт свою позицию `upto_seq` (= будущий номер сводки: голова + 1 перед записью; другой номер — точка
     откладывается), id точки `checkpoint_id` (= ожидаемый + 1), `op_id` каждого сегмента и отметки цепочек
     писателей (`chains`, `chains_complete`). Клиент сверяет сводку с точкой сервера (`historyVerifyCheckpoint`:
     `upto_seq = summary_seq = Checkpoint.upto_seq`, id, номера сегментов = `chunk_seqs`), сегменты — по `op_id`
     (`ingest` с `expect`; `op_id` — в AAD). Не сошлось или сводка не прочитана — журнал не применяется и курсор за
     точку НЕ двигается (прежде курсор перепрыгивал точку без сводки);
   - запись событий несёт цепочку писателя `HistoryBatch.chain` (случайный id на сессию журнала) и номер
     `chain_seq` (1, 2, … без пропусков; сегменты — вне цепочки). Читатель ведёт книгу цепочек (`ingest` с
     `chains`, непрозрачна для хоста, хранится рядом с курсором; после входа по точке — отметки сводки): пропуск
     номера — запись, спрятанная сервером, предупреждение «сервер не отдал N записей» в журнал диагностики; повтор
     уже виденного номера — не ошибка (операции сводимы). Цепочка, впервые встреченная не с номера 1, — пропуск,
     только если книга полна (устройство видело журнал с начала или вошло по полной сводке);
   - совместимость: записи и сводки до ревью (без полей) читаются как прежде, проверки, которым не на что
     опереться, пропускаются; прежние клиенты новые поля пропускают (неизвестные поля protobuf). Хвост журнала
     (последние записи) сервер по-прежнему может задержать — это неотличимо от задержки сети.

Web (spec 036 T017): вход по точке и сборка точки — модель движка (`backend/protocol/src/model/mod.rs`:
`history.head` → сводка со сверкой `verify_checkpoint` → сегменты с `op_id` из сводки; `checkpoint.rs`: условия
точки, горизонт, сводка с позицией `голова + 1`, CAS `DUPLICATE` без повтора); тесты
`backend/protocol/tests/model_history_checkpoint.rs`, `model_history_checkpoint_build.rs`. Прежний `v2/history.ts`
удалён. Замена истории точкой дальше горизонта (`needs_replace` → нотис `history_replaced`), откат головы сервера
(`history_rollback`) и книга цепочек писателей при синке (`ingest_chained`, `history_gap`) — тоже модель
(`checkpoint.rs`, перенос из прежнего `v2/history.ts`).

Desktop (ядро, общее с android): `HistorySync::joinLocked`/`loadCheckpointLocked` (вход по точке, сегменты свежими
первыми, `historyNeedsReplace` → `rowsApply{wipe}` модели и `onReplaced`), `buildCheckpointLocked` (условия по голове,
повторное использование сегментов по отпечатку, сверка «журнал не дописан», CAS — `casFailedFor`; сводка с позицией,
id точки и цепочками — S7-4), сверка точки и сегментов в `loadCheckpointLocked` (`historyVerifyCheckpoint`, `expect`),
книга цепочек `ingestChained` (`meta.chains`), откат головы в `pullLocked`/`joinLocked`; событие сессии `stateReady` с
`rotated` (смена ключа состояния) — принудительная точка с перезаливкой. Тест — `parvane_history_sync_tests` (вход по
точке, неизменные сегменты не перезаливаются, CAS, откат, горизонт 200 дней → замена; S7-3 — пачка не раньше окна,
S7-4 — пропуск цепочки, повтор после обрыва без пропуска, старая сводка при большем `upto_seq`); векторы
`history/checkpoint` в `parvane_protocol_vectors_tests`.

Android: то же ядро; `jni_history.cpp` — сессия движка `Session::openHistorySession`, запросы `busRequest` канала ID,
события сессии `journal`/`stateReady` → `HistorySync::onSessionEvent` (`jni_session.cpp`); режим замены — событие шва
`history_replaced` (`Client.kt` убирает показанное, чего нет в точке, и показывает строки заново). Сценарий —
`android/tgx_history_sync_flow.sh` (новое устройство получает историю журналом).

**С spec 035 (11 ноя 2026).** Модель движка умеет вход нового устройства по контрольной точке сама (курсор 0 →
`history.head` → сводка точки со сверкой S7-4 → сегменты пачками; тест `tests/model_history_checkpoint.rs`), а
перешифровка при смене ключа истории сохраняет исходные байты записей (`range-hold`: заменяющая точка не собирается
поверх непонятого, `tests/compat_circle.rs`). Точки web строит и читает модель (spec 036 T006/T017); ОТКРЫТО: ядро desktop/android — прежний путь
`history_sync.cpp`; `historyPage.pending`
(страница не в памяти) модель пока не выдаёт — профиль читается целиком при открытии.

## READ-2. Прочитанное на одном своём устройстве прочитано на всех, включая новое (spec 033)

1. **Маркер «прочитано до»** по чату (`ReadMark{chat, up_to_ts_ms, up_to_id}`, сведение — максимум, только растёт)
   сдвигается: прочтением, отправкой своего сообщения в чат, копией СВОЕЙ квитанции READ с другого своего устройства
   (быстрая дорога; web и desktop раньше её выбрасывали). В журнал истории — общей пачкой 30–120 с (HIST-1 п. 5,
   S7-3); бейдж другого своего устройства обнуляется быстрой дорогой (копия квитанции), не журналом.
2. **Счётчик непрочитанного** = число входящих неудалённых строк после маркера, решение — `historyIsUnread` (плюс
   ручная отметка STATE-2). Перенос и догрузка истории (журнал, точка) счётчик не увеличивают: после пачки счётчик
   чата пересчитывается от маркера.
3. **Квитанция собеседнику** — с повтором до успеха (READ-1 п. 3).

Web: `historyRows.ts` (`advanceMark`, `isUnread`; маркеры — записи `rm:<адрес>` шифрованного хранилища),
`sync.ts isUnreadIncoming` (только от маркера), `messages.ts markMessageListRead`, `v2/controller.ts` (копия своей
квитанции), провайдер (`setOwnSentListener`: своё отправленное сдвигает маркер); тест `historyRows.test.ts`,
сценарий `scripts/run_web_history_sync_e2e.sh` (бейдж второго устройства обнуляется ≤ 2 с, новое устройство — 0).

Desktop: прочтение — `Histories::readInboxTill` → `Parvane::MirrorReadTill` (личные чаты и группы: маркер в журнал,
квитанции только о ставших прочитанными, повтор до успеха `SendMutationWithRetry`); копия своей квитанции и своё
сообщение с другого устройства — `advanceMark` в `ApplyIncomingMutation`/`injectOnMain`; счётчик tdesktop —
`ApplyReadState` (`History::inboxRead(до последней прочитанной, число от historyIsUnread)`) после каждой пачки строк
журнала и при старте; локального списка прочитанных uuid (`parvane-read.txt`) нет — один раз переносится в маркеры.
Ядро — `HistorySync::advanceMark`/`readState`; тест `parvane_history_sync_tests`, сценарий
`desktop/verify_history_sync.sh` (бейдж 0 на офлайн-устройстве, на новом и после перезапуска).

Android: `jni_history.cpp historyMarkRead` (`Client.kt ViewMessages` → `ParvaneCore.markRead`: маркер чата в журнал,
квитанции только о ставших прочитанными, очередь с повтором в `history-local-<адрес>.json`); копия своей квитанции —
`advanceMark(own=false)`; своё сообщение с любого своего устройства сдвигает маркер в ядре. Счётчик — событие шва
`read_state` (`HistorySync::readState`) → `ParvaneStore.applyReadState` (выставляется заново; догрузка истории не
раздувает: прочитанное, пришедшее позже непрочитанного, границу не двигает), `removeMessages` снимает удалённое
непрочитанное со счётчика. Тест — `ParvaneStoreHistoryTest`, сценарий — `android/tgx_history_sync_flow.sh` (бейдж 0 на
desktop-устройстве, бывшем офлайн, на новом и после перезапуска X).

## PUBLIC-1. Публичные группы и каналы (spec 023, 15 окт 2026)

Решение пользователя: имя и секрет публичной группы серверу знать можно. Публичность — запись журнала группы
`SetPublic` (`GroupChange.set_public = 17`): имя (5–32, `[a-z][a-z0-9_]`, общее пространство с никами пользователей),
открытый секрет `S` (32 байта), настройки админа «Читать без вступления» и «История для новых участников». Из `S`
выводятся ключ публичной ссылки (вступление — `JoinByInvite`, эпоха при этом не устаревает) и ключ комплекта эпохи
`NewEpoch.public_bundle` (ключ конверта ‖ ключ отправки). В публичной группе конверт несёт экспорт Megolm-сеанса автора
(`GroupEnvelopeInner.public_session`). Каталог, поиск, открытие по имени и история — методы `group.public.*`.

1. Клиент с поддержкой показывает тип «Публичная/Частная», имя и честное предупреждение: переписку публичной группы
   может прочитать любой вступивший и технически сервер.
2. Клиент без поддержки обязан пропускать такую группу без падения.

Desktop (spec 029) поддерживает: ядро `v2_session_groups.cpp` (`checkPublicName`, `searchPublic`, `resolvePublic`,
`setGroupPublic`, `joinPublic`, `publicHistory`), tdesktop `parvane_client.cpp` (`SetGroupPublic`,
`SearchPublicGroups`, `LoadPublicPreview`, `JoinPublicGroup`); живой тест `tests/v2_session_tests.cpp` (spec 023:
публичность, имя, поиск, вступление по открытому секрету, история для нового участника).

Android (spec 031): `android/jni/jni_groups.cpp` (`nativePublic*` — методы `group.public.*` через сессию ядра);
`Client.kt` — поиск каталога, открытие по имени, превью не-участнику (`openPublic`, лента — `loadPublicHistory`),
вступление (`joinPublic`); `setup-tgx.sh` — кнопка «Вступить» у превью (патч `MessagesController` X). ОТКРЫТО:
сделать группу публичной и выбрать имя из android нельзя (JNI `nativePublicSet`/`nativePublicCheckName` есть,
экрана нет); сценария эмулятора нет.

## GPHOTO-1. Фото частной группы v2 шифруется (A0089-5, 30 окт 2026)

Фото частной группы раньше уходило открытым блобом: сервер видел картинку и загрузившего, скачать мог любой, кто знал
`file_id`. Теперь фото — такое же вложение, как в чате (CAP-1): PVB2 (BLOB-1) под секретом скачивания, а в записи
журнала группы `SetInfo` едет ОДИН 32-байтный секрет `avatar_key` (поле 4, было зарезервировано; поле 5 —
`avatar_domain`). Ключи выводятся одинаково во всех клиентах: `SHA-256("parvane/group-avatar/v1/" + метка + секрет)`,
метки `cap` (capability блоба, 32 байта), `key` (ключ PVB2, 32 байта), `nonce` (первые 12 байт). Вектор — в
`sync-rules.json` (секрет `01..20`).

1. **Частная группа** — фото шифруется новым случайным секретом; блоб грузится методами CAP-1 (ID-канал,
   `capability_hash`), `set_info` несёт и `avatar_file_id`, и `avatar_key`. **Публичная группа** (`SetPublic`) — как
   раньше, открытый блоб без ключа: переписка и так читаема вступившими.
2. **Ключ идёт со своим файлом.** Любая правка сведений, не трогающая фото (название, описание), обязана переписать
   в `set_info` прежние `avatar_file_id` и `avatar_key` — иначе запись без ключа сделает фото нечитаемым.
   Новый файл без ключа — открытое фото; снятие фото — оба поля пустые.
3. **Движок** хранит `GroupState.avatar_key`; ключ непустой только вместе с `avatar_file_id` и ровно 32 байта, иначе
   запись отвергается. `groupInfo` отдаёт `avatarKey` (base64).
4. **Читатель.** Есть `avatarKey` — блоб качается по capability анонимным каналом и расшифровывается; нет — как раньше
   (открытый блоб: записи до GPHOTO-1, публичные группы). Не-участник по ссылке-приглашению читает ключ из журнала
   группы, который сервер отдаёт по ссылке (превью).
5. **Смена и снятие фото** удаляют прежний блоб (`cloud.blob.delete`); блоб, загруженный другим администратором,
   сервер удалить не даст — это не ошибка.
6. Старые клиенты ключа не знают и показывают пустое фото частной группы; записи без ключа читаются как раньше.

Реализации — см. `clients` в `sync-rules.json`; тесты: web `groupPhoto.test.ts`, ядро `tests/blobcrypt_tests.cpp`
(`GPHOTO-1`).

**Смена правила (spec 035, 8 ноя 2026; PV-005, D1) — пункты 1–4 выше заменяются следующими.** Секрет в открытом
журнале видел сервер и любой получатель журнала (в том числе держатель одного `link_id`).
7. **В журнале — только связь секрета с файлом.** `SetInfo.avatar_key` (поле 4) зарезервировано; запись несёт
   `avatar_file_id` и `avatar_key_id = SHA-256(секрет)[..16]` (поле 6, 16 байт, только вместе с файлом). Вывод ключей
   блоба из секрета прежний (метки `cap`/`key`/`nonce`); вектор `avatarKeyIdHex` — в `sync-rules.json`.
8. **Участникам** секрет едет служебным групповым конвертом текущей эпохи `Content.group_avatar_key = 25`
   (`GroupAvatarKey{file_id, avatar_key, info_version}`), в ленте не показывается. Получатель принимает его, только
   если файл тот же и SHA-256 секрета совпадает с `avatar_key_id` журнала — подмену участником отсекает подписанная
   запись админа. После каждой новой эпохи держатель секрета шлёт его снова (новые участники получают его только так):
   движок `group_avatar_key_content`. `groupInfo` отдаёт `avatarKey` только сошедшийся с журналом (нет — фото не
   открывается) и `avatarKeyId`.
9. **Превью по ссылке (D1).** Для каждой действующей ссылки админ (или создатель ссылки) пишет запись журнала
   `InviteAvatarWrap{link_id, avatar_key_id, wrapped}`: секрет под ключом HKDF-SHA256 из секрета ссылки (он только во
   фрагменте адреса — сервер фото не видит), AAD = `link_id ‖ avatar_key_id`. Пишется при смене фото и при создании
   ссылки (`group_invite_avatar_wraps`), снимается отзывом ссылки и сменой фото. Держатель ссылки открывает секрет
   (`group_invite_avatar_key`), держатель одного `link_id` — нет.
10. **Перенос** (spec 035, T103; код удалён в T149, 12 ноя 2026): частные группы с фото до spec 035 перезаливались
   первым устройством администратора с новой версией. Не перезалитое до удаления фото у новых клиентов пустое.
Тесты: движок `group::tests::set_info_has_no_avatar_key_bytes`, `invite_avatar_wrap_opens_only_with_link_secret`,
`client_flow::group_photo_key_rides_epoch_envelope`.

**Клиенты (spec 035, 11 ноя 2026).** Поле 4 никто больше не пишет: запись `SetInfo` с фото и рассылку
`GroupAvatarKey` собирает движок (`groupSetPhoto` единой точки входа). Web — фото из показа группы моделью
(`GroupView.photo`, `viewGroup` в `v2/controller.ts`; у частной группы — только с сошедшимся секретом), превью по
ссылке из `InviteAvatarWrap`; перезалив открытого фото частной группы при разовом переносе — нужда модели
`needs{group_avatar_reupload}` (T115). Desktop и android (общее ядро) — `Session::uploadGroupPhoto` и
`setGroupPhotoLocked` → `Client::groupSetPhoto` (`v2_session_groups.cpp`, `v2_engine.cpp`); секрет, пришедший
конвертом эпохи после записи `SetInfo`, перечитывает сведения группы и докачивает фото (T126). Тест движка
`model_client.rs group_view_photo_is_live_in_host_mode`. ОТКРЫТО: tdesktop и шов android берут фото из сведений
ядра (`avatarKey`), а не из `GroupView.photo` (T126, T136).

## POLL-1. Анонимный опрос группы: голос не раскрывает автора участникам (A0031-2, 30 окт 2026)

Раньше голос анонимного опроса группы (`is_public` не задан) был обычным групповым `poll_vote` с известным
отправителем: каждый участник группы мог видеть, кто как голосовал (анонимность держалась только на скрытом списке
голосовавших в UI). Теперь адрес голосующего участникам не доходит:

1. **Голос уходит ТОЛЬКО автору опроса** личным сообщением (`poll_vote {poll, option_indexes}`) — не в группу. Группа
   (участники, кроме автора) такого сообщения не получает. Автор опроса, голосуя сам, ничего не шлёт.
2. **Автор считает и публикует итоги** в группу: `poll_vote` с `tally = true` (поле 3), `counts` (поле 4, число голосов
   по вариантам по порядку) и `voters` (поле 5, число проголосовавших). В итогах нет ни одного адреса. Публикация —
   с задержкой ~1,5 с (серия голосов сливается в одну); то же самое, что уже опубликовано (в том числе из журнала
   после рестарта), повторно не шлётся.
3. **Автор принимает личный голос** только от действующего участника группы опроса (членство знает он сам); голос
   не-участника и личное сообщение не ему отбрасываются. Голос в самой группе (клиент без POLL-1) автор тоже
   засчитывает. Правила срока, `no_revote` и викторины применяет автор.
4. **Участник (не автор)** в анонимном опросе группы считает только итоги автора и свой выбор: чужие голоса из группы
   игнорирует; итоги принимает ТОЛЬКО от автора опроса и ТОЛЬКО из чата опроса; счётчики приводятся к числу
   вариантов, отрицательные/дробные — 0, потолок 10 000 000. Свой голос (в том числе с другого устройства и из
   журнала: личное сообщение себя → автору) показывается как свой выбор.
5. Публичный опрос (`is_public`) и опрос 1:1 не меняются: голос — в чат, список голосовавших виден.
6. **Что автор знает.** Автор опроса видит адреса голосующих (в Telegram — нет); его клиенты их в UI не показывают.
   Сервер видит только шифртекст и отправителя личного сообщения автору (SEAL-1: адрес отправителя скрыт от сервера).
   Группа, где у автора нет клиента с POLL-1 (старый клиент автора), голоса из личных сообщений не считает: итоги
   обновятся только голосами, поданными в группу старыми клиентами.
7. Личное сообщение-голос не создаёт чата с автором ни у голосующего, ни у автора (служебное, не пузырь).

Реализации — см. `clients` в `sync-rules.json`; тесты: web `polls.anon.test.ts`, ядро `tests/poll_tests.cpp`
(routeVote, readTally, tallyContent) и `tests/v2_tests.cpp` (poll_vote tally), движок — вектор `poll-vote-tally`
(`proto/parvane/vectors/content/kinds.json`), android `PollStoreTest` (POLL-1), сторож `conformance.test.ts` (POLL-1).

## MD-1. Разбор Markdown заметок и статей — один на всех клиентах (6 ноя 2026)

Заметки «Знаний» и статьи в чате (ARTICLE-1) показываются по ОДНОМУ разбору Markdown: web —
`web/telegram-tt/src/components/parvane/markdown/markdown.ts`, desktop и android — его порт в ядре
`desktop/parvane-core/src/sections/markdown.cpp` (android берёт блоки через JNI `ParvaneSections.markdown`, своего
разбора на Kotlin нет). Сверка — общий образец `conformance/markdown/all-constructs.md` (тестовый файл пользователя со
всеми конструкциями): ответ `all-constructs.expected.json` пишет web (`markdown.test.ts`,
`PARVANE_WRITE_MD_FIXTURE=1`), ядро обязано совпасть блоками и кусками каждой строки
(`tests/sections/markdown_tests.cpp`). Правка разбора — в обоих файлах и с новым ответом образца.

Что входит: заголовки H1–H6 (закрывающие `#`, `{#id}`, якоря как у GitHub), абзацы (перевод строки — перенос),
списки (нумерация с первого номера, галочки и в нумерованных, вложенность отступом, блоки внутри пункта), цитаты с
любыми блоками и вложенные, callouts GitHub/Obsidian (`> [!NOTE]`, `> [!info]-`), код ```/~~~/отступ 4 (язык из info
string), черта, таблицы GFM, встроенные файлы; в строке — жирный/курсив (вложенные, правила CommonMark о пробелах и
подчёркиваниях внутри слова), `~~`, `==`, код в любом числе кавычек, экранирование `\`, HTML-сущности, разрешённые теги
`<br> <u> <ins> <mark> <sub> <sup> <kbd> <b> <strong> <i> <em> <s> <del>`, ссылки (заголовок, скобки в адресе,
`<адрес>`, голые адреса, `#якорь`), `[[заметки]]`, `#теги` (не из одних цифр), комментарии `<!-- -->` и `%% %%`
скрыты. Прочий HTML — текстом (не исполняется). Ссылка открывается только http(s)/mailto (подпись ≠ адресу — с
подтверждением на desktop). Поиск закрывающего знака ограничен окном (разбор не квадратичен).

## MEDIA-2. Спойлер медиа, подпись над медиа и альбомы (7 ноя 2026)

Опции окна отправки Telegram доходят до получателя (этап 4 ревью 7 ноя 2026). Поля `msg/v2/content.proto`:

1. **Спойлер** — `Media.spoiler = 15` (поле было в схеме). Отправитель ставит `true` у каждого фото, видео или GIF,
   отправленного «под спойлером»; получатель рисует медиа размытым до нажатия (`has_spoiler` Telegram). У голосовых,
   кружков и файлов поле не ставится и не читается.
2. **Подпись над медиа** — `Content.invert_media = 104` (`invert_media` сообщения Telegram): подпись (или текст с
   карточкой ссылки) показывается НАД медиа. Ставится только при непустой подписи; в альбоме — у каждого элемента,
   получатель берёт значение у элемента с подписью.
3. **Альбом** — `Media.album_id = 16`: 16 случайных байт, ОДНО значение у всех элементов альбома. Отправитель шлёт
   элементы подряд (загрузки параллельно, отправка — по порядку). Получатель группирует ПОДРЯД идущие сообщения одного
   автора в одном чате с одинаковым `album_id`, не больше 10 в группе (11-й — начало следующей группы). Фото и видео —
   альбом, файлы — группа документов. Сообщение без `album_id` или с другим `album_id` обрывает группу.
4. Клиент, не знающий правила, показывает элементы отдельными сообщениями без размытия — вреда нет.

## QUOTE-1. Цитата в ответе (7 ноя 2026)

«Цитировать и ответить» (выделить часть чужого сообщения): `Content.reply_quote = 105`,
`ReplyQuote { text ≤ 1024, entities ≤ 64, offset }`.

1. `text` — выделенный фрагмент, `entities` — сущности внутри фрагмента со смещениями ОТ НАЧАЛА фрагмента (UTF-16),
   `offset` — смещение фрагмента в тексте исходного сообщения (подсказка для подсветки, 0 — не задано).
2. Цитата действует только вместе с `reply_to`; без него движок её отбрасывает (`content_guard`), сущности
   обрезаются по тексту цитаты.
3. Получатель показывает цитату в плашке ответа вместо начала исходного сообщения (`quote_text` Telegram); клиент без
   цитат показывает обычный ответ.

Отложенное «без звука» и «Отправить, когда будет в сети» новых полей не требуют: `ScheduledMessage.content` —
сериализованный `Content` с `silent = 103`; «когда будет в сети» — `send_at_ms = 2147483646000` (`0x7FFFFFFE` с × 1000,
как `Api::kScheduledUntilOnlineTimestamp` desktop), уходит, когда собеседник в сети по присутствию.

## SUITE-1, DEVLOG-1, MODULES-1. Запас прочности протокола (spec 037, 16 ноя 2026)

1. **SUITE-1.** `SealedEnvelope.suite`: 0 — нынешний набор внешнего слоя. Конверт с незнакомым номером получатель
   отвергает («обновите приложение») и нынешним набором открыть не пробует. Набор выбирает отправитель по строке
   `features` сертификата устройства получателя (`kem.xwing` — X25519 + ML-KEM-768, появится позже).
2. **DEVLOG-1.** Виды `UserDeviceLogEntry.change` делятся по номеру: неизвестный 1–999 — звено цепочки без действия
   (подпись текущим нераскрытым SSK либо корнем; генезисом не бывает), 1000–1999 — журнал не продвигается. Запись
   `Rename` с адресом на другом домене проверяющий принимает; готовить такую смену клиенты и сервер пока не умеют.
3. **MODULES-1.** `ServerDescribeResponse.disabled_modules` — модули, выключенные администратором
   (`PARVANE_DISABLED_MODULES`); словарь: `planner`, `health`, `notes`, `files`, `music`. Клиент прячет модуль
   везде, где он всплывает; неизвестный идентификатор пропускает.
   С 17 ноя 2026 правила списка модулей — в движке (`modules.rs`, вызовы `modulesView`, `modulesSetOn`,
   `modulesMove`, `modulesSetBlock`; общий образец `conformance/modules/cases.json`): клиент хранит настройки
   устройства как JSON и показывает ответ движка. Выключенный модуль пропадает из навигации, поиска, меню
   вложений и меню сообщений, напоминания скрытого «Плана» не приходят. Карточка вида модуля, выключенного
   сервером, остаётся текстом (без действий). Модуль выключен только на устройстве (spec 041 E6, 19 ноя 2026) —
   карточка сохраняет действие, оно открывает лист «Модуль выключен»: «Включить» возвращает модуль в список
   устройства и выполняет действие, «Не сейчас» ничего не меняет.

Сделано в движке и identity (тесты — в `sync-rules.json`); клиенты — открыто.

## HEALTH-1, HEALTH-2. «Здоровье» в движке (spec 038, 16 ноя 2026)

1. **HEALTH-1.** Данные «Здоровья» — домен `parvane.health.v1`: запись `Entry` со случайным id, моментом, смещением
   местного времени, значением, единицей и источником; вода — отдельные прибавки; цель — регистр на показатель.
   День записи считает движок (сон — день пробуждения). Словарь видов и единиц — `specs/038-health-engine/spec.md`.
2. **HEALTH-2.** Свободный ввод разбирает только движок (`health_parse`); общий образец —
   `conformance/health-parse/cases.json`. Клиент показывает разобранное, неразобранное (`unparsed`) и отвергнутое
   (`problems`); своего разбора у клиента нет.

Сделано в движке; обвязки и экраны клиентов — открыто.

## Шард music (spec 039, 16 ноя 2026) — для клиентов пока правил нет

Серверная часть «Музыки» (методы `music.*`, ссылки потока с подписью) сделана; клиентского правила нет, пока нет
плеера. Клиент без «Музыки» методы не зовёт; карточка трека в чате (вид 26) появится отдельной записью.

## SESSION-1. Продление сессии без пароля (16 ноя 2026)

Причина: токен сессии жил 24 часа и не продлевался — web, desktop и android раз в сутки возвращали человека на экран
пароля, хотя ключи устройства оставались на месте.

1. Срок токена — 30 суток (`PARVANE_SESSION_TTL_SECS`). Gateway по-прежнему сверяет токен каждые 5 минут: отзыв
   устройства и смена пароля гасят его сразу.
2. `identity.session.renew` (канал PRE): прежний токен (подпись сервера цела, срок мог выйти не более чем на
   180 суток — `PARVANE_SESSION_RENEW_SECS`) и подпись ключа устройства того же вида, что `device_proof` входа
   (адрес и устройство — из токена, окно времени ±5 минут). Новый токен несёт то же поколение учётных данных,
   поэтому смена пароля, сделанная до продления, действует и на него.
3. Отказ: устройство отозвано или его нет в журнале устройств, пароль или ник сменён, аккаунт удаляется, токен
   слишком старый, подпись не сошлась. Тогда клиент показывает экран пароля; ключи и история остаются.
4. Клиент продлевает токен, когда сервер его отверг, и не показывает экран пароля, если продление удалось. Повторный
   отказ в течение 2 минут после продления второй раз не продлевается. Web дополнительно продлевает заранее — с
   половины срока.
5. Web больше не гасит сохранённую сессию после суток без активности: предел — 180 суток.

## HEALTH-3. Сводка «Здоровья» и запись ввода — в движке (17 ноя 2026)

1. `healthView {nowMs, tzMin}` отдаёт всё, что экран показывает числом: последнюю ночь и её отклонение от цели,
   режим сна за семь дней (сумма сна дня, «лёг / встал» главного сна), показатели с последним значением, итогом дня
   (шаги, вода), остатком до цели, изменением за неделю и месяц и рядом за 30 дней, последние записи. Клиент эти
   значения не пересчитывает.
2. Цели — регистры `Goal`: имя вида (`weight`, `steps`, `water`, …) либо `sleep_bed` / `sleep_wake` (минуты от
   полуночи; длительность по цели — от «лечь» до «встать» через полночь).
3. `healthCompose {entries, nowMs}` превращает разобранные записи (`healthParse`) в изменения: случайный id каждой
   записи; отметка `sleep_end` после незакрытой `sleep_start` (не старше суток) становится одним сном, отметка
   «лёг» удаляется; сон отрезком тоже закрывает незакрытое «лёг».
4. Контейнера ещё нет — сводка и изменения считаются от пустого состояния: первая запись создаёт контейнер.
5. Контейнер здоровья в web живёт тем же кодом, что контейнер «Плана» (`v2/personalSync.ts`); его ключи едут в
   копии ключей аккаунта (`health`) и в экспорте привязки устройства (`health`), указатель — вид состояния
   `OBJECT_KIND_HEALTH_CONTAINER`.
6. `healthEntries {kind, limit, nowMs, tzMin}` отдаёт записи вида новыми первыми и признак `hasMore`: подробный
   экран листает их страницами и сам список не собирает (`sleep` — сон вместе с отметками, пустой вид — все).
7. `healthCheck {entry, nowMs}` решает, годится ли запись, собранная формой (правка записи, дневной сон, шкала
   самочувствия): `problem` — `value` (вне диапазона показателя), `future`, `span` (сон короче десяти минут либо
   длиннее суток), `form`. Диапазоны те же, что у разбора текста (HEALTH-2): клиент своих не держит.
8. Питание и тренировки (17 ноя 2026, spec 041 B3; решение пользователя — блоки «Здоровья», а не «Плана») — те же
   записи `Entry` с полями `name`, `tag` и именованными числами `parts`: `food` (`value` — ккал, `tag` — приём
   `breakfast | lunch | dinner | snack | other`, `parts` — `protein`, `fat`, `carbs`, `fiber`, `grams`), `workout`
   (`value` — минуты, `tag` — `strength | run | walk | bike | swim | yoga | other`, `parts` — `km`, `exercises`).
   Число, которого в `parts` нет, — «неизвестно», а не ноль. Строку еды и тренировки разбирает движок (HEALTH-2):
   приём, не названный словом, определяется по времени записи; калории без числа считаются из БЖУ.
9. `healthView.nutrition` — итог дня (ккал и БЖУ), цели `kcal`, `protein`, `fat`, `carbs`, остаток `left`, приёмы
   пищи с записями (завтрак, обед и ужин — и пустыми), неделя калорий и среднее по полным дням. Полный день —
   закрытый либо прошедший с записями; сегодняшний незакрытый в среднее не входит. `healthView.activity` — шаги
   сегодня и по дням, активные минуты (сумма тренировок за семь дней) против цели недели `active_min`, число
   тренировок, пробег и тренировки с темпом. Еда, тренировки и их цели в `metrics` не входят.
10. Закрытый день питания — запись `food_close` с id `close-<день>` (регистр на день: закрытие с двух устройств —
    одна запись), `parts` — цели на момент закрытия. Клиент её не собирает: отдаёт в `healthCompose`
    `{kind: "food_close", day, tzMin, closed}`; `closed: false` — открыть день снова (надгробие).
11. Периоды подробного экрана — из сводки: у показателя `series` (30 дней) и `year` (двенадцать месяцев, среднее
    значений дней; у сумм — среднее дневных итогов), у сна `month` (сумма сна по дням) и `year` (средняя ночь по
    месяцам). Клиент только выбирает отрезок ряда. Сон с меткой `tag: "aside"` («не считать в сумму сна за сутки»)
    остаётся в записях, но в суммы дня, неделю и средние не входит. Питание прошлого дня — та же сводка на конец
    того дня (`healthView` с `nowMs` того дня).
12. Календарь «Плана» берёт здоровье у движка: `healthDays {fromDay, toDay}` → `{goals, days: [{day, closed,
    sleeps, foods, workouts}]}` (только дни с записями; сон «не в сумму» не входит; время — минуты от местной
    полуночи записи). «План» сон, еду и тренировки не хранит и не пишет: его строка ввода отдаёт их «Здоровью».
13. «Мои продукты» (18 ноя 2026): клиент показывает и пишет разбор `healthRecall {text, nowMs, tzMin}` — тот же
    итог, что у `healthParse`, но еда без чисел (`guess`) с названием прошлой записи еды получает её калории, БЖУ и
    граммы, теряет `guess` и несёт `recalled: true`; неразобранный кусок, равный такому названию («овсянка»,
    «овсянка 150 г»), становится записью еды. Название сравнивается точно после нормализации (регистр, `ё` → `е`,
    пробелы), берётся самая свежая запись с калориями; названы другие граммы, а у прошлой записи они есть — числа
    пересчитываются пропорционально. Калории либо БЖУ, названные в строке, не меняются и не дополняются. Разбор
    `healthParse` состояния не читает; клиент помечает подставленное («как в прошлый раз») и сам ничего не ищет.
14. Расчёты подробных экранов (20 ноя 2026, spec 041; модуль движка `domain/health_stats.rs`, общий образец
    `conformance/health-stats/cases.json`, тест `tests/health_stats_vectors.rs`). `healthView.sleep.stats`: за неделю,
    месяц и год (`periods`) — ночей, средняя ночь, средние отбой и подъём (среднее времени — от полудня, чтобы 23:30 и
    00:30 давали полночь) и их отклонение от цели, средняя ночь к цели; режим недели `regime` по разбросу отбоя —
    `stable` (≤ 45 мин), `floating` (≤ 2 ч), `off`, меньше четырёх ночей — `few`; `isWakeStable` — разброс подъёма ≤ 45
    мин; `lastBedDeltaMin` — отбой последней ночи к цели. `sleep.week[].deltaMinutes` — ночь к цели; `sleep.month[]`
    несёт «лёг / встал» (режим за месяц). Показатель: `periods` — среднее значений дней (`avg`, `avg2` у давления), дней
    с записями, число измерений, дни с целью (`goalDays`: у сумм набрано не меньше цели, у давления — цель верхняя
    граница, `isUpperBound`), `paceWeek` — наклон прямой по дням за 30 дней × 7 (не меньше недели между точками),
    `series[].goalMet`. `moodSleep.delta` — средняя оценка самочувствия в дни со сном меньше шести часов минус в
    остальные дни за 30 дней (в каждой группе не меньше двух дней). `healthEntries`: у записи показателя `delta` к
    предыдущей записи вида, у сна `goalDelta` к цели режима, у давления `pulse` — пульс в пределах 15 минут; у шагов и
    воды `days` — итоги дней новыми первыми с оценкой самочувствия дня и заметкой. Сон `tag: "none"` без отрезка и с
    нулём — «не спал»: ночь в ноль минут, входит в неделю и средние; `healthCheck` его принимает. Клиент эти числа не
    пересчитывает: процент от цели и литры — только оформление. «Встал» меньше чем через десять минут после
    незакрытого «лёг» (`healthCompose`) только снимает отметку «лёг» — сна нулевой длины нет.

## MUSIC-1. Очередь плеера «Музыки» — в движке (18 ноя 2026)

1. Очередь — JSON `{tracks, index, shuffle, repeat, order, seed}`: `order` — порядок проигрывания (номера `tracks`),
   `index` — место в нём, `-1` — ничего не играет. Клиент хранит её и передаёт в вызовы `musicQueue*`; ответ —
   новая очередь с готовыми `currentId` и `upcoming`.
2. «Следующий»: доигран сам (`auto`) — «повтор одного» оставляет трек, конец очереди без повтора останавливает;
   вручную — «повтор одного» не держит, конец очереди ведёт в начало. «Предыдущий» с первого трека — последний.
3. «Вперемешку»: играющий трек остаётся первым, остальное перемешивается по `seed` (Фишер — Йетс на xorshift) —
   один `seed` даёт один порядок на всех клиентах; выключение возвращает порядок списка, играющий трек тот же.
4. Правка: добавить следующим либо в конец, переставить, убрать (убран играющий — играет следующий на его месте),
   оставить только играющий. Очередь не длиннее 2000 треков.
5. Образец — `conformance/music-queue/cases.json`: шаги с ожидаемыми `currentId` и `upcoming`.

## MUSIC-4. Списки библиотеки «Музыки» на экранах — в движке (spec 041, 21 ноя 2026)

1. Порядок, группы и отбор считает движок вызовами без состояния: `musicLibrarySort` (исполнители `name` | `tracks`,
   альбомы `artist` | `title` | `year`, треки `artist` | `title`; равные — по `id`), `musicLibraryGroups` (первая буква
   заглавной, не буква — `#` в конце), `musicLibraryFilter` (каждое слово запроса — в одном из полей, без регистра),
   `musicPageMerge` (страница к показанному без повторов по `id`), `musicSearchRows` (найденное одним списком по
   названию, отбор `all` | `tracks` | `artists` | `albums`), `musicOfflineGroups` («Загруженное»: плейлисты в порядке
   пользователя, альбомы, отдельные треки; трек — в первой держащей группе, только лежащие на устройстве).
2. Длинные списки библиотеки (исполнители, альбомы, любимое, поиск) клиент читает страницами по 50 и подгружает при
   прокрутке; число в шапке раздела — из `music.info` (`library_tracks`, `library_artists`, `library_albums`,
   `starred_count`), а не из прочитанных страниц.
3. «Популярное на сервере» у исполнителя — `LibraryArtistResponse.popular`: прослушивания всех пользователей сервера,
   один человек — одно прослушивание трека в сутки; ссылка на поток для загрузки на устройство
   (`StreamUrlRequest.download`) прослушиванием не считается. Синглы — `Album.single` (тип релиза у сервера).
4. Образец — `conformance/music-library/cases.json` (вызов, вход, ожидаемый ответ).

## NOTES-1. Граф заметок и холст из графа — раскладка в движке (spec 040, 18 ноя 2026)

1. Раскладку считает движок, вызовами без состояния `notesGraphLayout` (граф) и `notesGraphCanvas` (холст из
   графа); вход и выход — JSON. Клиент передаёт заметки (`id`, `title`, `folder`, названия из ссылок `links`,
   метки `tags`, `isDaily`), записи «Плана» (`records`), область и зерно и рисует ответ: сам не раскладывает узлы,
   не расставляет подписи, не строит связи.
2. Один вход — один ответ на любом устройстве. В расчёте только `+ − × ÷ √` и округления, порядок обхода —
   порядок входа, координаты в ответе — целые. Зерно `seed` меняет только места.
3. Узлы и связи: ссылка на название без заметки — узел `missing:<название в нижнем регистре>` (один на название);
   ссылка на заметку вне области не рисуется; на пару узлов одна связь в сторону первой ссылки, встречная ставит
   `mutual`; записи с одним названием — один узел `record`; `degree` — число разных соседей.
4. Область `scope`: `all`; `folder` — папка с подпапками (корень — пустая строка, только заметки самого корня);
   `around` — заметка `note` и соседи до глубины 1–3 (иное приводится к границам; неизвестная заметка — пусто);
   `tag` — метка с вложенными `метка/…`, `#` и регистр не важны. `hideOrphans` убирает узлы без связей,
   `hideMissing` — заметки, которых ещё нет; заметки дней включает `withDays`, папка и метка их не касаются.
5. Граф: радиус кружка растёт с числом связей (6…28), подпись — прямоугольник `label` шириной по числу знаков
   (`charWidth` × знаки, не шире `labelMaxWidth`). Кружки и показанные подписи РАЗНЫХ узлов не пересекаются;
   сторона подписи (`bottom`, `top`, `right`, `left`) выбирается так, чтобы её не пересекали связи самого узла;
   подпись, которой места не нашлось, приходит с `show: false` — первой скрывается подпись узла с меньшим числом
   связей. Связные группы раскладываются порознь, заметки без связей стоят отдельным рядом по папкам; блоки
   (`blocks`: `group` и `singles`) не накладываются. Заметки одной папки внутри группы стягиваются друг к другу.
6. Связь — квадратичная кривая от `(x1, y1)` до `(x2, y2)` (края кружков) с опорной точкой `(cx, cy)`;
   `curved: true` — дуга в обход чужого кружка, иначе прямая. Наконечник у `to`, при `mutual` — и у `from`
   (рисует клиент).
7. Холст из графа: карточки только существующих заметок той же области (заметок, которых нет, и записей «Плана»
   на нём нет). Связная группа — уровнями от заметки с наибольшим числом связей (`level`), длинный уровень
   переносится; заметки без связей — сеткой по папкам; места кратны `grid`. Стрелка несёт стороны карточек
   (`fromSide`, `toSide`). Случайности нет — `seed` на холст не влияет.
8. Списки `folders` (папки с обычными заметками и их число) и `tags` — для выбора области; от области не зависят.
9. Закреплённые узлы (spec 040 T10, 20 ноя 2026): `pinned: [{id, x, y}]` — точки, переставленные руками; узел стоит
   ровно в `(x, y)` (центр, координаты прошлого ответа), его связная группа раскладывается заново от своих мест вокруг
   закреплённых; система координат и места свободных блоков — те же, что у раскладки без закрепления; узлы свободного
   блока, на которые легли закреплённые, отходят от них, остальное — на местах. Угол поля — `bounds.x`, `bounds.y`. Неизвестный id и нечисловое место пропускаются. Клиент передаёт закреплённые, когда
   раскладка пересчитывается и так (новая связь, другая область), — сама перестановка граф не перекладывает.
10. Образец — `conformance/notes-graph/cases.json`: вызов, вход и полный ожидаемый ответ; его читают тест движка
   (`backend/protocol/tests/notes_graph_vectors.rs`, пересоздание — `NOTES_GRAPH_REGEN=1`) и тест web через WASM
   (`notesGraphEngine.test.ts`). Изменение раскладки = пересоздание образца и пересборка WASM в одном шаге.

Сделано в движке и в web (обёртка `notesGraphEngine.ts`, экраны графа, малого графа и холста из графа — spec 041 D2, 18 ноя 2026; web-раскладка удалена); desktop и android — открыто.

## NOTES-2. Сведение заметки, правленной на двух устройствах (spec 040 T9, 19 ноя 2026)

1. Сводит движок: вызовы без состояния `notesMerge {base, mine, theirs}` → `{text, conflict, parts, autoLines}` и
   `notesMergeResolve {base, mine, theirs, choices}` → `{text}`. Построчное трёхстороннее слияние от общей версии
   `base`: правки разных мест складываются, одинаковые берутся один раз, перевод строки `\r\n` — как `\n`.
2. Одно место, изменённое по-разному, — расхождение: `conflict: true`, `text` — моя версия целиком, `parts` — участки
   по порядку (`{text: [строки]}` сведено само, `{base, mine, theirs, line}` — расхождение, `line` — номер строки в
   моей версии с 1). Тексты, которые сравнивать слишком дорого, — одно расхождение на весь текст.
3. Решение человека — выбор по порядку расхождений: `mine`, `theirs` либо `both` (моя строка, затем их); не заданный
   выбор — `mine`. Клиент не сводит текст сам.
4. Пока расхождение не решено, ничего не теряется: в заметке — моя версия, чужая — копией «… (конфликт …)» рядом.
5. Образец — `conformance/notes-merge/cases.json` (тест движка `backend/protocol/tests/notes_merge_vectors.rs`, тест
   web `notesMerge.test.ts` через WASM).

Сделано в движке и в web (экран расхождения `NoteConflictView.tsx`, очередь текстов без связи `notesOutbox.ts`);
desktop и android — открыто (там сведение пока своё либо его нет).

## NOTES-3. Сведение холста, правленного на двух устройствах (spec 040 T9, 20 ноя 2026)

1. Сводит движок: вызов без состояния `notesCanvasMerge {base, mine, theirs}` (тексты файла `.canvas`) →
   `{doc, conflicts}`. Слияние трёхстороннее по id карточек и стрелок от общей версии `base`.
2. Поле, изменённое одной стороной, — её; обеими одинаково — берётся раз; обеими по-разному — моё, `conflicts` + 1.
   Порядок: мой, затем добавленное только у них (в их порядке).
3. Удалённое одной стороной и не тронутое другой — удалено; изменённое другой — остаётся её версией (+1 к
   `conflicts`). Стрелки к ушедшим карточкам убираются.
4. Незнакомые поля карточек, стрелок и файла сохраняются и сводятся так же. Пустой `base` — новый холст на двух
   устройствах; нечитаемая чужая версия — остаётся моя (`conflicts` 1).
5. Клиент пишет файл со сверкой версии: запись поверх чужой — сводит от версии, которую видел, и пишет снова; правка
   другого устройства, пришедшая во время своей несохранённой, сводится в открытом холсте. Сам клиент не сводит.
6. Образец — `conformance/notes-canvas-merge/cases.json` (тест движка `backend/protocol/tests/notes_canvas_merge_vectors.rs`,
   тест web `notesCanvasMerge.test.ts` через WASM). `doc` сравнивается как JSON-объект.

Сделано в движке и в web (`notesCanvasMerge.ts`, `notesStore.ts saveCanvas`, `NotesCanvas.tsx`); desktop и android —
открыто.

## MUSIC-2. Плейлисты «Музыки» — личный контейнер, порядок и правки в движке (17 ноя 2026)

1. Плейлисты — контейнер домена `parvane.music.v1` (`proto/parvane/music/v1/playlists.proto`), один на пользователя;
   сервер видит шифртекст. Ссылка на контейнер — объект личного состояния `OBJECT_KIND_MUSIC_CONTAINER`.
2. Плейлист и трек в плейлисте — регистры со своим id, сводятся по метке, удаление — надгробие. Трек — отдельная
   запись: два устройства, добавившие по треку одновременно, ничего не теряют.
3. Показ клиент берёт из `musicStateJson`: плейлисты по времени создания, треки по `rank`, при равных — по id записи.
4. Действие пользователя — `musicCompose {action, nowMs}`: `create {name}` (ответ несёт `id`), `rename`, `delete`,
   `add {playlistId, tracks}` (повтор трека пропускается — `skipped`), `remove {itemId}`, `move {itemId, toIndex}`.
   Клиент записывает полученные `changes` (`musicPrepareLocal`) и сам мест не считает.
5. Трек, которого на сервере больше нет, остаётся строкой с подписью из плейлиста и не играет.
6. Ключи контейнера едут новому устройству в экспорте привязки (поле `music`) и в копии ключей аккаунта.

## TRACK-1. Трек «Музыки» в чате (17 ноя 2026)

1. `Content.music_track = 26`: `track_id`, `server` (домен сервера библиотеки), `title`, `artist`, `duration_secs`,
   `text` («исполнитель — название»). Байтов трека сообщение не несёт.
2. Клиент с «Музыкой» показывает карточку и играет трек из библиотеки своего сервера, если `server` — его сервер и
   трек там есть; иначе карточка только показывает. Клиент без «Музыки» показывает `text`.
3. Сообщение видимое: непрочитанное, пересылается карточкой, на него можно ответить.

## PLAYLIST-1. Плейлист «Музыки» в чате (spec 041 C4, 19 ноя 2026)

1. `Content.music_playlist = 28` (`MusicPlaylistShare`): `name`, `server` (домен сервера библиотеки), `tracks` —
   треки по порядку (`track_id`, `title`, `artist`, `duration_secs`), не больше 500, и `text` (название и первые
   треки). Это снимок плейлиста отправителя: ни байтов треков, ни ссылки на его личный контейнер (MUSIC-2) в нём нет,
   правки исходного плейлиста к получателю не приходят.
2. Пределы схемы — в байтах UTF-8: отправитель урезает подписи по байтам и берёт треки по порядку, пока сообщение
   умещается в операцию.
3. Клиент с «Музыкой» показывает карточку (название, число треков и длительность, первые треки, «Слушать», «Открыть»)
   и играет треки из библиотеки своего сервера, если `server` — его сервер; трек, которого там нет, пропускается.
   «Сохранить к себе» создаёт новый плейлист своего контейнера с теми же треками по порядку. Клиент без «Музыки»
   показывает `text`.
4. Сообщение видимое: непрочитанное, пересылается карточкой, на него можно ответить. Права группы по типу (GROUP-2)
   его не касаются — это не медиа.

## PLANNER-2. Свободное время, расписание текстом, поиск и тренировки «Плана» — в движке (spec 041 E1, 19 ноя 2026)

1. Вызовы без состояния `plannerFreeTime`, `plannerScheduleParse`, `plannerSearch`, `plannerWorkouts`; вход и выход —
   JSON. Повторы «Плана» клиент раскрывает своей моделью и передаёт готовые занятые промежутки и записи; что из них
   следует, решает движок. Образец — `conformance/planner-tools/cases.json`.
2. Свободное время: день, где `load + minutes > budget`, пропускается; окно ищется внутри `[dayStart, dayEnd]`,
   сужённого частью дня (`morning` — до 12:00, `evening` — с 17:00, `weekend` — только сб и вс); сегодня — не раньше
   `nowMinute`, начало округлено вверх до 5 минут; занятое расширено запасом `margin`. Каждый просвет даёт одно окно;
   порядок — первые окна каждого дня, потом вторые. Пометки: `isFreeAfter` (после окна до конца дня свободно),
   `isBeforeFirst` (окно кончается до первых дел дня).
3. Расписание: кусок — строка либо часть строки между `·` и `;`; день недели первым словом действует до следующего;
   время «10-11», «10:00–11:00», «с 10 до 11»; одно начало с минутами — событие на час (`isEndGuessed`); название — до
   первой запятой, с заглавной буквы; срок «до 31 декабря» / «до 15.12.2026» / «до 2026-12-15» в любом куске (без года —
   ближайшая такая дата не раньше `today`). Непонятый кусок — в `problems` и не добавляется; заголовок дня — никуда.
4. Поиск: каждое слово запроса (регистр и «ё» не различаются) — подстрока названия, описания или группы. Фильтр:
   `all`, `events`, `tasks` (невыполненные), `done`. «Прошло» — день раньше сегодня либо сегодня и конец не позже
   `nowMinute`; «Впереди» — по дате, без даты — в конце, экземпляры одного ряда (`series`) — одной строкой (ближайшей).
5. Тренировки для «Активности» «Здоровья»: запись «Плана» со словом тренировки из разбора «Здоровья», невыполненная, с
   сегодняшнего дня на `days` дней; сегодняшняя — пока не закончилась.
6. Действие над одной записью — `plannerRecordAction` (20 ноя 2026; меню по правой кнопке и задача на шкале дня):
   `tomorrow` — день после дня записи (экземпляра ряда), но не раньше завтра; задача без даты — на завтра; шаблон ряда
   без дня — `mode: none`. `place` — день `dropDay`, минута `dropMinute` вниз с шагом `step` (15 по умолчанию),
   длительность своя (нет — 60 мин), начало сдвигается так, чтобы конец был не позже полуночи. В обоих срок задачи
   раньше нового дня сдвигается на новый день (`due`). Разовая запись правится сама (`move`), день ряда отделяется
   (`detach`). `duplicate` — копия `record` без `id`, `occurrences`, `origin`, `source`, `instanceDay`: день ряда —
   разовой записью на этот день, шаблон — таким же рядом; задача — в очереди, шаги не отмечены (`mode: copy`).

## CALL-3. Сверка ключей звонка словами (spec 041, доски `PhCalls`, `DkCalls`, 20 ноя 2026)

1. Сверку считает движок: вызов без состояния `callSasWords {local, remote}` → четыре слова либо `null` (нет
   отпечатка). `local` и `remote` — отпечатки DTLS обеих сторон из SDP (`a=fingerprint`), порядок не важен:
   отпечатки сортируются, склеиваются через `|`, от SHA-256 берутся первые четыре байта — номера слов.
2. Список один — 256 английских слов в движке (`backend/protocol/src/call_sas.rs`), от языка интерфейса не зависит
   (решение пользователя 20 ноя 2026): собеседники с разными языками видят одни и те же слова. Клиент их только
   показывает через « · ».
3. Образец — `conformance/call-sas/cases.json` (тест движка `backend/protocol/tests/call_sas_vectors.rs`, тест web
   `components/parvane/call/callSas.test.ts` через WASM).

Сделано в движке и в web; desktop и android — открыто (там прежние значки из `crypto.cpp`, со словами web не
сравниваются).


## CLOUD-3. История версий и доступ к файлу копией (spec 041, доски `ZdNotesX`, `ZdFilesX`, `RpFiles`, 20 ноя 2026)

1. **История версий — в движке** (`backend/protocol/src/domain/cloud.rs`). У узла `cloud.v1` — множество содержимых
   (`CloudCreate.blob` и каждый `CloudSetBlob`); текущее — наибольшее по метке, как прежний LWW-регистр. Хранится не
   больше `VERSIONS_KEEP` = 10 версий с текущей; старшие уходят в надгробия `CloudGone` (не больше 32 на узел, в
   снимке — `CloudEntry.gone = 23`, прежние версии — `CloudEntry.versions = 22`). Итог не зависит от порядка
   применения: версии — множество, из него убираются надгробные блобы и повторы блоба, остаются новейшие.
2. **Окно черновика.** Правки одного устройства подряд в пределах 10 минут от начала окна — одна версия: при
   локальной правке движок (`CloudState::coalesce_local`, до меток) пишет в `CloudSetBlob.supersedes = 6` блобы
   прежнего черновика и переносит начало окна (`draft_since_ms = 7`). Возврат прежней версии — правка с `keep`
   (не черновик, её следующая правка не заменит). Создание узла черновиком не бывает.
3. **Стирание блобов.** `purgedBlobs` состояния — все версии стёртых узлов и надгробия живых, на которые не
   ссылается ни одна версия. Стирает устройство загрузившего (как DOMAIN-2). Надгробие заменённого черновика несёт
   загрузившего НОВОЙ версии: участник совместной папки так не заставит чужое устройство стереть свой блоб.
4. **Доступ к одиночному файлу — копией.** Владелец отдаёт файл сообщением-файлом в личный чат с
   `Media.to_files = 22` (копия блоба в медиа чатов, как «Отправить в чат»). Устройство получателя с «Файлами»
   делает серверную копию в свою квоту (`cloud.blob.copy` по секрету вложения) и создаёт в корне своего диска узел с
   `CloudCreate.from = 9` = автор сообщения; id узла — первые 16 байт SHA-256 от `parvane/cloud-received/v1/` ‖ id
   сообщения (другие устройства получателя узел не удваивают). Такой узел, пока лежит в корне, показывается в
   «Доступных мне» → «Файлы»; перенесённый в папку — обычный файл диска. Вложение с другого сервера серверной копией
   не взять: устройство получателя переливает тот же шифртекст со своего сервера на свой (скачивание по секрету
   через федерацию, загрузка в свою квоту под новым секретом; ключ файла прежний). Правки у владельца и получателя
   дальше расходятся; общей папки не создаётся.
5. Клиент без «Файлов» (desktop, android) показывает такое сообщение обычным файлом; поля `to_files` и `from`
   пропускает. История версий у них сводится тем же движком.
6. **Перенос между контейнерами уносит историю** (личный диск ↔ совместная папка, папка стала совместной и обратно).
   Хост копирует блобы всех версий (`cloud.blob.copy`, чужие — так же копией) и шлёт создание с `versions`
   (прежние, от новой к старой, `[{blob, thumb?, mtime}]`); движок (`cloud_json::push_op`) разворачивает его в
   создание старейшей версией и `setBlob` с `keep` для каждой следующей — порядок и времена версий сохраняются, окно
   черновика их не сливает; больше `VERSIONS_KEEP − 1` прежних — отказ. Загрузивший версий в назначении — переносящий
   (его копии), источник стирается целиком и отдаёт в сборку все свои версии. «Сделать копию» — новый файл с чистой
   историей (только текущая версия).

Сделано в движке и в web; desktop и android — открыто.

## REPORT-2. Жалобы: выбор адресата и список у админа группы

**spec 041 (20 ноя 2026): движок и web — сделано; desktop и android — открыто.**
Окно жалобы — одной формой: причина (`spam`, `fraud`, `insult`, `illegal`, `other`; прежние коды REPORT-1 сводятся к
ближайшей), комментарий, «Кому». Кому можно отправить, решает движок (`reportForm`, `backend/protocol/src/report_inbox.rs`):
«админам группы» — только жалоба на сообщения группы, где есть владелец либо админ с правом удалять сообщения или банить
(кроме себя); «администратору сервера» — если сервер объявил ключ жалоб (`server.describe.report_public_key`). Жалоба
админам уходит как в REPORT-1 — личным сообщением `mod_report` каждому, шифруется как вся переписка; нового серверного
хранилища нет. Список у админа (`reportInbox`) собирается из полученных карточек `mod_report` этой группы: строка на
сообщение, число разных пожаловавшихся, самая частая причина, время последней жалобы, до пяти комментариев. «Отклонить»,
«Удалить сообщение» и «Заблокировать в группе» закрывают жалобу объектом-признаком личного состояния
`OBJECT_KIND_REPORT_CLOSED = 23` с ключом `<g:домен:hex>/<op_id>` (`reportClosedKey`) — закрытие видят все устройства
админа, другие админы закрывают у себя. Жалобы администратору сервера в списке группы нет. Общий образец —
`conformance/reports/cases.json` (cargo `tests/report_vectors.rs`, web `modReports.test.ts`). Desktop и android: окно
прежнее, списка нет; объект `REPORT_CLOSED` журнал состояния хранит как вид новее своей версии.
«Участник с …» в строке списка — `memberSinceMs` из `reportInbox`: время записи журнала группы, добавившей автора
(`Member.joined_ms`, в сведениях группы — `members[].joinedMs`); клиент передаёт участников полем `members`.

## REPORT-3. «Скрыть у меня сообщения этого участника»

**spec 041 (20 ноя 2026): движок и web — сделано; desktop и android — открыто.**
Галочка окна жалобы на сообщение группы (доска `XdChat`; включена по умолчанию, у своих сообщений её нет) пишет
объект-признак личного состояния `OBJECT_KIND_MEMBER_HIDDEN = 24` с ключом `<g:домен:hex>/<адрес участника>`
(`reportHiddenKey`). Видят его только свои устройства. Приёмный фильтр модели (`contentHidden`) не показывает сообщения
этого участника в этой группе — любое содержимое; строки модели остаются, и снятие объекта («Показать» в уведомлении
web) возвращает сообщения. Desktop и android: движок общий — их фильтр через `contentHidden` скрывает сам; галочки
в окне жалобы нет.

## SECKEY-1. Ключ безопасности — второй фактор входа на сервере (spec 041, доска `ZdProfileX`, 20 ноя 2026)

**Сервер и web — сделано; desktop и android ключей не заводят (решение «сначала web»), их поведение — п. 6.**
Аппаратный ключ WebAuthn (USB/NFC; ES256 либо EdDSA) у аккаунта на сервере. Проверяет identity
(`shards/identity/src/v2/webauthn.rs`, `seckey.rs`): подпись над `authenticatorData ‖ SHA-256(clientDataJSON)`, тип и
вызов в `clientDataJSON`, источник (https на rpId или его поддомене; http — только `localhost`; список
`PARVANE_WEBAUTHN_ORIGINS`), хэш rpId (`PARVANE_WEBAUTHN_RP_ID`, по умолчанию домен сервера), присутствие
пользователя, рост счётчика подписей. Аттестация не проверяется (`none`).

1. **Когда спрашивается.** У аккаунта есть хотя бы один ключ и включено «Требовать ключ при входе», а
   `identity.session.issue` пришёл от устройства, не доказавшего ключ устройства журнала (`device_proof`, ID-01) —
   то есть от нового устройства, вошедшего паролем. Пароль (и подтверждение в Telegram, если включено) проверяется
   первым: без верного пароля вызова нет. Ответ — шаг без токена: `seckey_required`, `seckey_challenge` (32 байта,
   5 минут, один на пару «аккаунт + устройство», расходуется первой попыткой), `seckey_ids` (allowCredentials),
   `seckey_rp_id`, `seckey_recovery`; секрет доверия 2FA в ответе сохраняется. Повтор входа — с
   `SessionIssueRequest.seckey` (`SecKeyAssertion`); отказ — снова шаг с `seckey_rejected` и новым вызовом.
2. **Не спрашивается:** устройство журнала, доказавшее себя (`device_proof`), продление сессии
   (`identity.session.renew`), аккаунт без ключей, выключенное требование.
3. **Потерян ключ.** Вход ключом восстановления вместо ключа безопасности: `SessionIssueRequest.recovery_key` —
   сервер сверяет его с копией корня, как в RECOVER-2 (неверный — шаг с `recovery_key_wrong`; 5 попыток в минуту).
   Другое привязанное устройство снимает ключ или выключает требование.
4. **Не запереть себя.** Ключ добавляется, только когда у аккаунта есть копия корня на сервере (иначе `NOT_FOUND`):
   у аккаунта с ключом безопасности всегда есть ключ восстановления. Ключей не больше 10 (`LIMIT`), тот же ключ
   дважды — `DUPLICATE`.
5. **Управление** — `identity.seckey.challenge` / `add` / `list` / `remove` / `set_required`; заводит и снимает
   только действующее устройство журнала (`FORBIDDEN` — сессии, вошедшей одним паролем), `add`, `remove` и
   `set_required` — со свежим `identity.session.reauth`. Первый ключ включает требование. Смена ника переносит ключи,
   удаление аккаунта стирает.
6. **Desktop и android** ключей не заводят и шаг не показывают: поля ответа им неизвестны, токена нет — вход на
   НОВОМ устройстве аккаунта с ключом заканчивается отказом («не удалось войти»). Уже привязанные desktop и android
   входят как прежде (доказательство ID-01), продление сессии работает. Чтобы привязать новый desktop/android,
   владелец временно выключает «Требовать ключ при входе» на web.

## MUSIC-3. Общие плейлисты «Музыки» — на сервере, права у сервера (spec 041, 21 ноя 2026)

1. Общий плейлист хранит шард `music` открытым текстом: музыка не E2E, сервер и так видит треки. Методы
   `music.shared.list/get/create/edit/delete/items/member/leave/join`. Личные плейлисты остаются в контейнере
   `music.v1` (MUSIC-2); «Сделать общим» и «Сделать личным» — перенос треков клиентом с удалением прежнего.
2. Роли: владелец (название, доступ, участники, ключ вступления, удаление), «добавляет» (`EDITOR`: добавить, убрать,
   переставить треки; повтор трека пропускается), «слушает» (`LISTENER`: только чтение). Права проверяет сервер.
   Участник своего сервера зовётся по адресу; позванный видит плейлист с `invited`, первое чтение снимает отметку.
3. Доступ: `MEMBERS` — только участники (не участнику — `NOT_FOUND`), `SERVER` — читает любой пользователь сервера
   (раздел «Общие плейлисты сервера»), правят по-прежнему участники.
4. Плейлист чата: карточка `music_playlist` несёт `shared_id = 5` и `join_key = 6`; получатель вступает ключом
   (`EDITOR`) и открывает живой плейлист. Снимок треков и `text` в карточке остаются для клиентов без общих
   плейлистов. Смена ключа владельцем закрывает вход по прежним карточкам.
5. Живых событий нет: клиент перечитывает плейлист (`get` с `if_version` → `unchanged`), пока на него смотрят.
6. Desktop и android общих плейлистов не показывают; карточку с `shared_id` показывают как PLAYLIST-1.
