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
desktop `parvane/parvane_client.cpp` (`prepareIncoming` → `NotePendingAndMayAdvance`).

## SYNC-2. Непрочитанное не держит курсор вечно

Придерживать дисковый курсор из-за нерасшифрованного можно ограниченное число
попыток. Копии под наш `device_id` могло не создаться вовсе (каталог устройств
у отправителя протух), и тогда курсор застыл бы навсегда, а клиент
пересинхронизировал бы всю историю при каждом старте.

- После N попыток (desktop: `kRepairAttempts` = 3) сообщение пропускается с
  записью в лог. История в этом случае восстанавливается авто-линковкой.

Реализации: desktop `NotePendingAndMayAdvance` (`tdata/parvane-pending.txt`);
web `mayAdvanceDiskCursor` + `localState.loadRepairAttempts` (9 сен 2026).

## PROFILE-1. Профиль собеседника перечитывается по TTL

Имя и аватар меняются на другом устройстве. Кэш профиля обязан иметь срок
годности; резолв «один раз за сессию» запрещён. Пуша об изменении профиля в
протоколе нет: у identity нет прав публикации в инбокс пользователя
(`IDENTITY_NATS_PUBLISH` = только `_INBOX.>`), поэтому TTL — единственный
механизм.

Реализации: web `resolveDisplayNames` на каждом проходе синка;
desktop `g_resolvedAt` + `kProfileTtlMs` (10 мин), включая собственный профиль.

## READ-1. Прочитанное журналируется локально и подтверждается

`msg.chat.read` уходит без ответа. Клиент обязан:

- записать прочтение локально ДО публикации (переживает перезагрузку);
- считать сообщение прочитанным по объединению локального журнала и серверного флага;
- повторять публикацию, пока сервер не вернёт `read=true`.

Реализации: web `localState.loadReadUuids/saveReadUuids`, `retryUnconfirmedReads`;
desktop `g_reportedRead` + `tdata/parvane-read.txt`, `RetryUnconfirmedReads` (9 сен 2026).

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

## Обязательный сценарий: устройство отсутствовало

Все e2e гоняются на чистом стеке, где оба клиента онлайн и устройства уже в
каталоге. Случай «отправили, пока второго устройства не было» не проверялся
никогда — именно он и ломался. Сценарий обязан быть в каждом клиенте:

- desktop: `desktop/verify_offline_device.sh`
- web: `scripts/run_web_offline_device_e2e.sh`
