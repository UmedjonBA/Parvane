# Parvane — независимое ревью безопасности, архитектуры и качества кода

Дата: 2026-09-27. Ревизия: `2aef0418` (ветка рабочего дерева). Режим: только чтение.
Запущено: `cargo test --workspace` (backend) — все зелёные (calendar 8, call 18, cloud 13,
gateway 11, identity 44, messenger 46+1, notes 8, parvane-e2e 10, parvane-types 8+3,
preview 6, push 0). `npx vitest run` в `web/telegram-tt` запустить не удалось:
`package-lock.json` рассинхронизирован с `package.json` (`npm ci` падает на
`chokidar/glob-parent/readdirp/picomatch`), а `npm install` не может склонировать
git-зависимости (`github:Ajaxy/opus-recorder`, `zubiden/*`, `mytonwallet-org/*`) из
песочницы. Клиентские сборки (tdesktop, Android) не запускались по условию.

Строки указаны по `cat -n` текущего дерева. Все находки в разделе 2 подтверждены
чтением кода; всё, что не удалось подтвердить, вынесено в 2.3.

---

## 1. Резюме

1. Общая оценка: серверная изоляция «пользователь → свои subject'ы» на gateway и проверка
   токена в шардах сделаны в целом добросовестно (SQL параметризован везде, `unwrap` на
   пользовательском вводе в проде нет, ACL NATS сверяется тестом). Но у периметра есть
   дыра уровня протокола, а несколько заявленных в README свойств (sealed sender, Ed25519
   JWT, защита от подмены ключа) в коде не выполняются.
2. **P-01 (critical)** — `to` из payload попадает в NATS-subject без валидации (messenger
   sealed-send, call.signal); async-nats subject не проверяет → инъекция `PUB` в шину от
   имени шарда: подделка серверных событий в инбокс любого пользователя (`msg.user.>`),
   plaintext-сообщения от чужого имени, ложные `cleared/read/notify`, обрыв соединения шарда.
3. **P-02 (critical, Android)** — автор группового сообщения берётся из Megolm-plaintext
   (`inner.from`) без проверки; SKDM принимается с самозаявленным `sender_identity` →
   любой участник группы выдаёт себя за любого на Android.
4. **P-03 (high)** — линковка устройств: SAS = 6 цифр только от эфемерного ключа нового
   устройства, без commitment → сервер-MITM за ~10⁶ keygen подбирает ключ с тем же кодом
   и получает полный экспорт (приватный Olm-аккаунт, сессии, расшифрованная история).
5. **P-04/P-05 (high)** — web не замечает смену identity-ключа собеседника (каталог
   перезаписывает сравниваемое значение до сравнения); «sealed sender» не скрывает
   отправителя от сервера (`sender_identity`/`sender_signing_key` в открытом виде, ack
   с реальным отправителем).
6. **P-06/P-07 (high)** — отзыв устройства не рвёт открытую сессию gateway и не проверяется
   ни в одном identity-обработчике, кроме verify; `device_id` в prekeys/link не привязан к
   claim `dev`; один украденный JWT (24 ч) выключает 2FA и отзывает все устройства без
   пароля; смены пароля в системе нет.
7. **P-08..P-10 (high)** — cloud: незавершённые аплоады без TTL и вне квоты (заполнение
   диска); messenger: повтор чужого `id` подменяет копии и live-пуш, страница sync без
   лимита байт ломает синк жертвы навсегда; инъекция «призрачных» сообщений через
   публичный `sender_signing_key`.
8. Инфраструктура: JWT-секрет (HS256, а не Ed25519, как в README) и приватный VAPID-ключ
   лежат в SQLite, бэкапы незашифрованы; контейнеры root с общим томом всех БД; TURN без
   фильтра peer-адресов; Caddy без HSTS/frame-ancestors; CSP web разрешает `connect-src` на
   любой хост.
9. Клиенты: Android — экспортированная Activity принимает `gateway/autologin/autosend` из
   Intent + cleartext; desktop/Android — ключи Olm и расшифрованная история на диске
   открытым текстом вне защиты паскодом; web — `trust_secret` 2FA в localStorage.
10. Метаданные: любой аккаунт видит presence всех и может подписаться на «кто печатает
    кому» по любому chat-id; каталог отдаёт телефон/дату рождения всем авторизованным и
    перечисляется через `%` в LIKE.

---

## 2. Находки

### 2.1. Сводная таблица

| ID | Серьёзность | Компонент | Файл:строка | Что не так | Эксплуатация (кратко) | Исправление | Статус |
|---|---|---|---|---|---|---|---|
| P-01 | critical | messenger, call, gateway | `backend/shards/messenger/src/main.rs:1371`, `backend/shards/call/src/main.rs:248,262`, `backend/shards/gateway/src/main.rs:743-747` | Клиентский `to` → NATS-subject без проверки символов; async-nats 0.37 не валидирует subject | `to` с пробелом/CRLF → инъекция `PUB msg.user.<жертва>` с произвольным JSON от имени messenger | Валидация адреса allowlist-набором символов на gateway и в шардах; `is_valid_subject` перед publish | исправлено в 8d4fbc9a; unit gateway/messenger/call + live `parvane-integration` (инъекция через `to` на messenger и до шины на gateway) |
| P-02 | critical | android | `android/jni/parvane_jni.cpp:437-441`, `:410-414` | Автор группового = `inner.from` из Megolm-plaintext; SKDM принимается с `sender_identity` из plaintext | Участник группы вкладывает `{"from":"bob@…"}` → показано как от Bob; подменяет ключ Bob | Автор = wire `from` (как tdesktop), verifySender для групп; SKDM только с identity Olm-конверта | исправлено в f2e7723d; правило E2E-1 (conformance.test.ts); Android в облаке не собран |
| P-03 | high | web/desktop linking | `web/telegram-tt/src/api/parvane/linking.ts:9,32-37`, `provider.ts:1515-1517,1552-1555`, `desktop/parvane-core/src/linking.cpp:304-316` | SAS 6 цифр только от `eph_pub` нового устройства, без commitment | Сервер подбирает P-256 ключ с тем же кодом, подменяет оффер, читает бокс с `file_key` экспорта | PAKE или SAS от обоих ключей с commitment, ≥40 бит; не экспортировать приватный Olm-аккаунт | исправлено в 4f6610c2; web LINK-1 (vitest), parvane_linking_tests; живая линковка (e2e_web_linking.mjs) не гонялась |
| P-04 | high | web e2e | `web/telegram-tt/src/api/parvane/e2e.ts:738-741`, `:816-823` | `identityByContact` перезаписывается из каталога до `rememberContactIdentity` | Сервер подменяет identity контакта — предупреждения о смене ключа нет | Отдельное множество «виденных» identity, не засеваемое каталогом | исправлено в 7242c9ed; e2eTrust.test.ts |
| P-05 | high | web/desktop/android протокол | `web/telegram-tt/src/api/parvane/messages.ts:199-205`, `sync.ts:484-486,656-658`, `desktop/parvane-core/src/e2e.cpp:889-895` | «Sealed sender»: долговременные ключи отправителя в открытом виде, получатель шлёт `ack.sender` | Сервер джойнит `sender_identity` с каталогом или читает ack → полный граф общения | Внешний ECIES-слой на identity получателя; ack без `sender`; честно описать в README | частично: 0af4c8b7 — ack без sender, README честно описывает границы; ECIES-слой поверх Olm отложен (новый wire-формат во всех трёх клиентах) |
| P-06 | high | identity, gateway | `backend/shards/identity/src/main.rs:1038-1041,2161-2171`, `gateway/src/main.rs:408-412,557-582` | Отзыв проверяется только в verify; gateway верифицирует токен раз при auth; `req.device_id` не сверяется с `claims.dev` | Отозванное устройство до 24 ч шлёт запросы, перезаписывает бандл другого устройства, отзывает остальные | Общая функция decode+revoked; gateway рвёт сессии по отзыву/exp; `device_id == dev` | исправлено в e525d3f7; live: отзыв → verify падает, сессия gateway рвётся переверификацией (`PARVANE_GATEWAY_REVERIFY_SECS`) |
| P-07 | high | identity | `backend/shards/identity/src/main.rs:1382-1391`, `782-812`, `498-499` | twofa off / device.revoke / setkey — только по JWT, без пароля; смены пароля нет | Украденный JWT → выключить 2FA → входить по паролю; lock-out владельца | Пароль или свежий login_token для этих операций; endpoint смены пароля; короткий exp+refresh | исправлено в a471e830; live: revoke без пароля/чужого устройства отклонён |
| P-08 | high | cloud | `backend/shards/cloud/src/main.rs:144-167`, `223-227` | Незавершённые аплоады без TTL, вне квоты, никогда не удаляются | 40 чанков/с × 1 МиБ без complete → диск | Учитывать чанки в квоте, GC по возрасту, лимит незавершённых | исправлено в 496beae8; cloud unit + e2e_cloud.py live |
| P-09 | high | messenger | `backend/shards/messenger/src/main.rs:212-231`, `1097-1098`, `2229-2230` | `INSERT OR IGNORE` по клиентскому `id` без проверки `rows_affected`, копии и доставка идут всё равно; страница sync без лимита байт | Повтор чужого `id` с junk-копией для устройства жертвы; 2–20 сообщений по ~900 КБ → ответ sync > 1 МиБ → синк жертвы висит вечно | Отклонять событие при 0 строк; лимит байт на ciphertext/копию; страница по байтовому бюджету | исправлено в 496beae8; live: повтор id сохраняется один раз |
| P-10 | high | messenger | `backend/shards/messenger/src/main.rs:1085-1092`, `284-287` | `sender_signing_key`/`copies[].signing_key` не доказаны при send, но дают выборку в sync | Sealed-сообщение с чужим публичным signing-ключом → «исходящее» в ленте жертвы | Подпись `send:<id>:<ct>` ключом отправителя; self-копии только с доказанным ключом | исправлено в 0af4c8b7; SEND-1 (conformance), parvane_e2e_tests |
| P-11 | high | infra | `backend/shards/identity/src/main.rs:104-105,1097-1110`, `push/src/main.rs:103`, `scripts/backup_server_dbs.sh:39` | JWT HS256-секрет (README: Ed25519) и VAPID private в SQLite; бэкапы без шифрования/прав | Утечка identity.db/бэкапа → подпись JWT за любого | Секрет в env/файл 0600, ротация (kid); шифровать бэкапы | исправлено в 81479ace; identity unit (ключ 0600, миграция из БД); live: ключ в файле рядом с БД |
| P-12 | high | android | `android/app/src/main/java/org/parvane/app/MainActivity.kt:19-23`, `AndroidManifest.xml:9,12` | Экспортированная Activity читает `gateway/autologin/autosend` из Intent; cleartext разрешён | Любое приложение запускает Activity с `gateway=ws://attacker` → JWT уходит атакующему; `autosend` шлёт сообщения | Extras только под `BuildConfig.DEBUG`; только `wss://`; `usesCleartextTraffic=false` | исправлено в 724c09b2; Android в облаке не собран |
| P-13 | high | desktop, android storage | `desktop/parvane-core/src/e2e.cpp:167-172`, `backend/shared/parvane-e2e/src/lib.rs:28-31`, `desktop/tdesktop/…/parvane_client.cpp:1503-1511,1534`, `android/jni/parvane_jni.cpp:239-249` | Pickle Olm без ключа, JWT, trust-секрет, расшифрованная история — plain-файлы вне паскода tdata / только песочница | Копия tdata/`files/` = все ключи и история | Шифровать через Storage tdesktop / OS keychain; Android Keystore + EncryptedFile | частично: d531b538 + 1b4f406b (однозначный формат, миграция без пропусков; storecrypt/e2e-тесты 40/40); медиа-кэш Android остаётся plain; tdesktop/Android не собраны |
| P-14 | high | web | `web/telegram-tt/src/api/parvane/connectionController.ts:141-147,179-180` | `trust_secret` (обход 2FA) в localStorage открытым текстом | XSS/расширение + пароль = вход без 2FA | Хранить в `SecureE2eStorage`; привязать к device_id, ротировать | исправлено в ce87ead8; secureStorage.test.ts |
| P-15 | high | identity + telegram-bot | `backend/infra/telegram-bot/parvane_tg_bot.py:101-102`, `identity/src/main.rs:1737-1739` | Бот подтверждает вход по одному нажатию Start, без «Подтвердить/Отклонить» | Атакующий с паролем шлёт жертве `t.me/bot?start=<login_token>` → JWT + `trust_secret` навсегда | Inline-кнопки с показом устройства/IP; подтверждение только по callback | исправлено в a471e830; identity unit; живой Telegram-бот не проверялся |
| P-16 | high | infra/turn | `backend/infra/turn/main.go:108-127`, `coturn.conf:6-18` | Нет `PermissionHandler`/`denied-peer-ip`; relay на `0.0.0.0` | Любой пользователь через TURN шлёт UDP/TCP на 127.0.0.1/10.x/169.254.169.254 VPS | Фильтр peer (loopback/private/link-local), `no-loopback-peers`, denied-peer-ip | исправлено в f9605fe5; `go test` TestPeerAllowed, `go vet` |
| P-17 | medium | push | `backend/shards/push/src/main.rs:151-162`, `246-276` | `endpoint` не валидируется (SSRF/внутренние адреса), число подписок не ограничено; отправка в том же цикле, что register | Тысячи endpoint'ов на один аккаунт → на каждое входящее N POST'ов на чужой URL (амплификация), стойло шарда | Только `https://` + deny приватных IP, cap подписок на пользователя, spawn с семафором | исправлено в e401ef57; push unit + live (endpoint без схемы/http/приватный IP отклонены) |
| P-18 | medium | gateway | `backend/shards/gateway/src/main.rs:764-774`, `700-707`, `777-781` | Подписка на любой `msg.typing.<digits>` и на `presence.*`; публикация typing в любой чат | «Кто кому печатает» по хэшу адреса жертвы (кадр несёт `from`+`to`), онлайн-статус всех | typing только для своих чатов/групп (состояние членства), presence по списку контактов | исправлено в ce87ead8; gateway unit + live (`presence.*`, `msg.typing.>`, чужой инбокс отклонены), EPHEMERAL-1 |
| P-19 | medium | identity | `backend/shards/identity/src/main.rs:344-352`, `361-371`, `522-537` | LIKE без экранирования `%`/`_`; search/resolve отдают `phone/birthday/bio` всем авторизованным | `q=%` + префиксы → весь каталог с телефонами | `ESCAPE '\'`, минимальная длина, приватность полей | исправлено в ce87ead8; identity unit (like_escape, public_card) |
| P-20 | medium | identity, gateway | `gateway/src/main.rs:431-432` vs `493-518`; `identity/src/main.rs:1211-1215` | `client_ip` подмешивается только pre-auth; `identity.token.issue/register` доступны после auth с пустым `client_ip` (= без IP-лимита) | Password spraying 10/мин на каждый логин без IP-лимита из любого аккаунта | Инъекция `client_ip` всегда для issue/register или запрет после auth | исправлено в a471e830 (client_ip подмешивается после auth в рамках P-43); проверено чтением gateway/acl.rs |
| P-21 | medium | identity | `backend/shards/identity/src/main.rs:2102-2117`, `654-669` | 20 fetch/мин на пару → OTK жертвы вычерпываются за минуты | X3DH деградирует до signed-prekey-only для всех новых собеседников | Суточный кап, кэш «тот же requester → та же OTK», алерт остатка | исправлено в e401ef57; identity unit (суточный кап, повторная выдача OTK, watermark) |
| P-22 | medium | messenger, gateway | `backend/shards/messenger/src/main.rs:311-327`, `417-431`; `gateway/src/main.rs:719-730` | edit принимает plaintext, gateway запрещает plaintext только для send | Автор/скомпрометированный клиент переводит E2E-сообщение в открытый текст на сервере | Принимать при edit только тот же E2E-kind; расширить проверку gateway на edit | исправлено в 0af4c8b7; live: plaintext edit через gateway и смена E2E-вида на messenger отклонены |
| P-23 | medium | web + preview | `web/telegram-tt/src/api/parvane/media.ts:404-410,442-449`, `preview/src/main.rs:128-181` | Тайлы для любой локации (в т.ч. чужой live) запрашиваются у сервера с токеном; тайлы уходят в OSM; кэш и частота без лимита | Сервер/OSM узнают координаты из зашифрованных сообщений с привязкой к аккаунту; бан IP у OSM | Крупный zoom/шум, без токена, локальный рендер; per-user лимит, cap кэша | исправлено в 01a551ee; preview unit (кап кэша, zoom ≤ 15), web zoom-кламп; per-user лимит тайлов |
| P-24 | medium | web blobcrypt | `web/telegram-tt/src/api/parvane/blobcrypt.ts:66-87` | `decryptRange` — AES-CTR без тега; plaintext в медиа-декодер до проверки целого файла | Cloud/сервер бит-флипами формирует произвольный вход декодера | Чанковый AEAD (тег на чанк) | исправлено в 01a551ee; BLOB-1: blobcrypt.test.ts + parvane_blobcrypt_tests с общим вектором |
| P-25 | medium | web/desktop e2e | `web/telegram-tt/src/api/parvane/e2e.ts:36-42,721-724`, `desktop/parvane-core/src/e2e.cpp:577-587` | `signed_prekey_sig` никем не проверяется | Сервер подменяет SPK → тихий DoS установления сессий | Проверять подпись `signing_key` устройства при fetch | исправлено в 7242c9ed; e2eTrust.test.ts, parvane_e2e_tests (KEY-1) |
| P-26 | medium | web/desktop/android | `sync.ts:670-673`, `parvane_client.cpp:5531-5533`, `parvane_jni.cpp:397-404` | Вердикт `unknown` (каталог недоступен) — fail-open | Сервер отвечает ошибкой на prekeys.fetch → спуф `inner.from` показывается | Не показывать до подтверждения, retry, не ack | исправлено в f2e7723d; E2E-1 |
| P-27 | medium | web vs desktop/android | `desktop/parvane-core/src/e2e.cpp:1192-1194`, `web/…/messages.ts:337`, `sync.ts:201-203`, `parvane_client.cpp:5557-5559` | Формат Megolm-plaintext разошёлся: desktop/android `{from,content}`, web голый `content` | Кросс-клиентские группы ломаются; «починка» через `inner.from` даёт P-02 на web | Зафиксировать формат в conformance: голый `content`, автор = wire `from` | исправлено в f2e7723d; E2E-1 (векторы в трёх клиентах) |
| P-28 | medium | cloud | `backend/shards/cloud/src/main.rs:65-72`, `339-344`, `500` | Download читает файл (до 512 МиБ) в память + base64 в последовательном цикле | 20 req/с × 512 МиБ → OOM/голодание cloud для всех | Стрим чанков, cap range, spawn+семафор | исправлено в e401ef57; cloud unit (стриминг, кап чанков) |
| P-29 | medium | cloud, web | `cloud/src/main.rs:233-240,436-439`; `web/…/messages.ts:746-750` | Имя E2E-вложения хранится и логируется открыто | Сервер знает «кто кому какой файл» | Непрозрачное имя при `encrypt:true`, логировать только id | исправлено в ce87ead8; e2e_cloud.py; имя `blob` в трёх клиентах |
| P-30 | medium | preview | `backend/shards/preview/src/main.rs:67-72`, `309-335`, `101` | Последовательный цикл, таймаут на хоп (4×5 с), per-user лимита нет | Медленный сервер с редиректами → превью/тайлы не работают ни у кого | spawn+семафор, общий дедлайн, per-user лимит | исправлено в e401ef57; preview unit |
| P-31 | medium | infra/deploy | `backend/infra/deploy/Dockerfile.shards:14-24`, `docker-compose.yml:14-15` | Контейнеры root, без `read_only/cap_drop`; один том `db:/data` на все шарды | RCE в preview/cloud = root + чтение identity.db (JWT-секрет) | `USER`, hardening, том на шард | исправлено в f9605fe5; compose валиден (yaml), не деплоилось |
| P-32 | medium | infra/Caddy, web CSP | `backend/infra/deploy/Caddyfile:33-47`, `web/telegram-tt/vite.config.ts:290,298` | Нет HSTS/X-Frame-Options/frame-ancestors/nosniff; CSP `connect-src … http: https: ws: wss:` | Clickjacking; при XSS ключи уходят на любой хост | `header {…}` в Caddy; `connect-src 'self' wss://<host>`; `frame-src 'none'` | исправлено в f9605fe5; Caddyfile/vite CSP; заголовки живого сервера не проверялись |
| P-33 | medium | gateway | `backend/shards/gateway/src/main.rs:557-582`, `496`, `526`, `595-616` | `sub` без лимита и без rate-limit; `timeout_ms` не ограничен | Тысячи подписок/висящих `reqmany` на сессию → память gateway/NATS | Cap подписок на сессию, дедуп, `timeout_ms ≤ 30 с` | исправлено в e401ef57; gateway unit (64 подписок, clamp_timeout) + live ACL |
| P-34 | medium | messenger | `backend/shards/messenger/src/main.rs:2053-2063`, `2082-2087`; `666-677` | Инвайты бессрочные/многоразовые, `revoked` никем не выставляется; группы без согласия и без лимита размера | Утёкшая ссылка = вечный вход; спам-группы на N адресов | TTL/max_uses/revoke; лимит участников; повторное добавление только по инвайту | исправлено в e401ef57; messenger unit (TTL/uses/revoke инвайтов, лимит участников, согласие) |
| P-35 | medium | call | `backend/shards/call/src/main.rs:118-133`, `255-262` | Invite любому `to` без cooldown; размер sdp/candidate не ограничен | 20 «звонков»/с жертве, строка в `calls` на каждый | Cooldown по паре, лимит `ringing`, `sdp ≤ 64 КиБ` | исправлено в e401ef57 + 01a551ee (cooldown только пока звонит, ≤20 invite/мин); call unit, parvane_call_tests live |
| P-36 | medium | web | `web/telegram-tt/package.json:113` | libolm (`@matrix-org/olm`) deprecated, открытые CVE-2024-45191/2/3 | Side-channel в браузере | vodozemac-wasm (миграция pickle есть в lib.rs) | отложено: `vodozemac-wasm` не опубликован в npm, `@matrix-org/matrix-sdk-crypto-wasm` — другой API (OlmMachine); libolm остаётся, `npm audit --omit=dev` 0 |
| P-37 | medium | identity | `backend/shards/identity/src/main.rs:2057-2071`, `1204`, `2110` | In-memory лимитеры по произвольным ключам без длины/выселения | 120 issue/мин с уникальными логинами до 4 МиБ → память | `user.len() ≤ 128` до лимитеров, чистка bucket'ов | исправлено в e401ef57; identity unit (limiter_key, выселение) |
| P-38 | medium | all shards | все `main.rs` (`SqlitePool::connect(...mode=rwc)`) | Нет WAL/busy_timeout; пул 10 соединений на rollback-журнале | `database is locked` под нагрузкой; OPERATIONS.md предполагает WAL | Общий хелпер `journal_mode(Wal).busy_timeout(30s)` | исправлено в e401ef57; parvane-db unit |
| P-39 | medium | web e2e | `web/telegram-tt/src/api/parvane/secureStorage.ts:50-60`, `178-191` | Non-extractable ключ рядом с шифртекстом без пользовательского секрета; там же пароль аккаунта | XSS/расширение = все ключи + пароль | Опциональный PIN → wrap ключа; не хранить пароль | исправлено в ce87ead8; secureStorage.test.ts (PIN) |
| P-40 | low | messenger | `backend/shards/messenger/src/main.rs:1464-1472` | Sealed-send не верифицирует токен (только gateway при auth) | Отозванное устройство шлёт sealed до обрыва WS | `verify_token` и для sealed | исправлено в e525d3f7; live: send с поддельным токеном не сохранён |
| P-41 | low | messenger | `:467-489`, `:513-517`, `:793-805`, `:1301-1305` | «Удаление» оставляет метаданные; `delete_group` не трогает сообщения; `inbox_queue` не чистится | Рост БД, остаточные метаданные | Физическое удаление, GC очереди | исправлено в f9605fe5; messenger unit (gc, надгробия при delete_group) |
| P-42 | low | messenger, identity | `messenger/src/main.rs:1476,1543,1580`; `identity/src/main.rs:374,1709,1830-1832` | Граф общения, поисковые запросы, PII, dev-код подтверждения в `info!` | Логи = метаданные | `debug`, без адресов; dev-код только при `PARVANE_DEV=1` | исправлено в ce87ead8; логи graph/PII на debug; проверено grep |
| P-43 | low | identity | `:1665-1667`, `:1908-1922`, `:1482-1484`, `:2162` | telegram/email.confirm pre-auth без IP-лимита; нет политики пароля; токен без `dev` неотзываем | Перебор секрета бота, сжигание чужих попыток кода; пароль «1» | IP-лимит на confirm; минимум 8 символов; требовать `dev` | исправлено в a471e830; live: короткий пароль и чужой домен отклонены |
| P-44 | low | web | `sync.ts:288-304`, `polls.ts:79-82`; `connectionController.ts:224-229`; `localState.ts:274-276`; `media.ts:250`; `entities.ts:33-34` | `poll_close/vote` без проверки автора/чата; typing доверяет `to`; scheduled-черновики в localStorage; Blob с MIME отправителя; entities без clamp, `tg:` в text_url | Закрыть чужой опрос; ложный «печатает» в группе; утечка черновиков; deep-link | Проверять creator/chat; scheduled → SecureE2eStorage; octet-stream для не-медиа; whitelist http/https | исправлено в f9605fe5; p44.test.ts |
| P-45 | low | desktop | `desktop/parvane-core/src/gateway_ws_transport.cpp:169-171`, `parvane_client.cpp:9543-9547` | `PARVANE_WSS_INSECURE` отключает TLS-verify; `PARVANE_AUTOLINK_GRANT` даёт грант без UI | Env-переменная в прод-запуске | `#ifdef PARVANE_DEV` | исправлено в 724c09b2; tdesktop в облаке не собран |
| P-46 | low | android | `android/jni/parvane_jni.cpp:450-451,519`; `android/app/build.gradle.kts:31-34`; `libtd/…/Client.kt:269-271` | Текст сообщений и SAS-код в logcat; release подписан debug-ключом; gateway подменяется файлом в `/data/local/tmp` | Bugreport/ADB; подмена APK | Убрать текст из логов; релизный keystore; оверрайды только в debug | исправлено в 724c09b2; Android в облаке не собран |
| P-47 | low | parvane-e2e | `backend/shared/parvane-e2e/src/lib.rs:139-144` | `expect` в FFI-пути → unwind через `extern "C"` | Abort клиента при внутреннем сбое | Возвращать NULL/Option | исправлено в f9605fe5; parvane-e2e unit |
| P-48 | low | web e2e | `e2e.ts:631-633`; `e2e.ts:576-582` | Импорт бэкапа без верхней границы итераций и проверки соли; линковка переносит приватный Olm-аккаунт, отзыв не отзывает `legacySigners` | DoS вкладки чужим файлом; потомки навсегда подписываются как старое устройство | Кап итераций, проверка соли; переносить только inbound-ключи | исправлено в 4f6610c2 (перенос только inbound-ключей) + 01a551ee (кап итераций, соль/iv/данные); e2eTrust.test.ts |
| P-49 | low | preview | `preview/src/main.rs:264-283`, `326-333`, `102`, `227-233` | Пробелы deny-листа (fec0::/10, 6to4, Teredo, 192.0.0.0/24); reqwest без `.no_proxy()`; URL в логах и бессрочном кэше | Обход пиннинга при `HTTPS_PROXY`; приватные ссылки в логах | Явный CIDR deny-лист, `.no_proxy()`, логировать host | исправлено в f9605fe5; preview unit deny_list_gaps_are_closed |
| P-50 | low | infra | `backend/infra/deploy/deploy.sh:14-15,59`, `docker-compose.yml:21`, `turn/README.md:25`, `nats/.env.example` | Прод-IP/SSH-порт/логин в репо; `.env` целиком в контейнер NATS; статик-кред TURN `parvane/parvane` в инструкции; `.env.example` без preview/push паролей | Цель для брутфорса; компрометация nats = все секреты | Вынести в gitignored env; `environment:` только нужное; убрать `TURN_USER` | исправлено в f9605fe5; deploy.sh не запускался |
| P-51 | low | deps | `backend/Cargo.lock` (`rsa 0.7.2` через `web-push→jwt-simple`; `reqwest 0.11`/`hyper 0.14`/`rustls 0.21` в preview) | Marvin (RUSTSEC-2023-0071) в дереве; maintenance-ветка в самом экспонированном шарде | `cargo audit` красный; CVE без бэкпортов | `reqwest 0.12`; заменить `web-push` | исправлено в f9605fe5; `cargo audit -n` 0 (rsa — только в неиспользуемом sqlx-mysql, игнор обоснован в .cargo/audit.toml), `npm audit --omit=dev` 0 |
| P-52 | low | cloud | `cloud/src/main.rs:247-265`, `100/500`, `456/527`; топики `lib.rs:73-78` | `recipients/filename/mime` без лимитов; чанк 1 МиБ + base64 > NATS max_payload; нет `file.delete`; внутренние ошибки клиенту | Транзакция на сотни тысяч INSERT; файл не скачать; квота необратима | Лимиты; `max_chunk ≤ 700 КиБ`; `file.delete` | исправлено в 496beae8; cloud unit, e2e_cloud.py live |

### 2.2. Подтверждения по коду (цитаты)

**P-01.** `backend/shards/messenger/src/main.rs:1362-1371` — recipient из клиентского `to`
попадает в subject:
```rust
    let recipients = resolve_recipients(pool, &stored.to, &stored.from).await?;
    for r in &recipients {
        ...
        enqueue(pool, r, &stored.id.to_string(), now).await?;
        nc.publish(msg_inbox(r), bytes.into()).await?;
```
`backend/shards/call/src/main.rs:248-262`:
```rust
        let to = event.payload.to.clone();
        ...
        nc.publish(call_inbox(&to), serde_json::to_vec(&relay)?.into()).await?;
```
Gateway для sealed проверяет только `to.contains('@')` (`gateway/src/main.rs:743-747`), для
`call.signal` не проверяет `to` вовсе (`:712-759`). async-nats 0.37 (`~/.cargo/registry/…/
async-nats-0.37.0/src/client.rs:214-219`) не вызывает `is_valid_subject` (определена в
`lib.rs:1597`, нигде не используется) и пишет `PUB {subject} {len}\r\n` как есть
(`connection.rs:467-479`). `to` вида `bob@s 0\r\n\r\nPUB msg.user.bob@s <n>\r\n<json>\r\nPUB call.user.x`
даёт messenger'у (ACL `msg.user.>`) публикацию произвольного `InboxPush`/`cleared`/`read`/
`notify` в инбокс любого пользователя. Web-клиент обрабатывает такие кадры без проверки
происхождения (`sync.ts:1064-1082`) и рендерит plaintext-`message` как есть (`sync.ts:691-700`
пропускает только `encrypted/group_encrypted`). Клиентский `from` в форджированном
`InboxPush` — любой.

**P-02.** `android/jni/parvane_jni.cpp:437-441`:
```cpp
        if (!inner.is_object()) return;
        if (inner.contains("from") && inner["from"].is_string()) author = inner["from"].get<std::string>();
        if (inner.contains("content")) sm.content = inner["content"];
    }
    const bool out = (author == g_self);
```
и `:410-414` (SKDM с `sender_identity` из уже подменённого `sm.content`):
```cpp
        if (parvane::contentKind(sm.content) == "skdm") { // ключ группы от участника
            parvane::e2e::groupAcceptKey(sm.content.value("group", std::string()),
                sm.content.value("sender_identity", std::string()),
```
Для сравнения tdesktop (`parvane_client.cpp:5516-5517`) берёт автора только из wire `from`,
web (`sync.ts:250-258`) требует совпадения `inner.sender_identity` с identity конверта.

**P-03.** `web/telegram-tt/src/api/parvane/linking.ts:32-37`:
```ts
export async function sasCodeForEphPub(ephPubB64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytesToBuffer(base64ToBytes(ephPubB64)));
  const view = new DataView(digest);
  const code = view.getUint32(0) % SAS_MODULUS;
```
Старое устройство считает код от `offer.eph_pub`, полученного от сервера
(`provider.ts:1515-1517`), и шифрует бокс с `file_key` экспорта на этот же ключ
(`provider.ts:1552-1555`); новое принимает любой `grant.eph_pub` (`provider.ts:724`).
Экспорт — `buildState()` целиком, включая `account` и `pickleKey` (`e2e.ts:326-341,555-557`).

**P-04.** `web/telegram-tt/src/api/parvane/e2e.ts:738-741` и `:816-823`:
```ts
    const primary = devices.find((device) => device.device_id === '') || devices[0];
    if (primary.identity_key !== this.identityKey) {
      this.identityByContact[contact] = primary.identity_key;
    }
```
```ts
  rememberContactIdentity(contact: string, identity: string): boolean {
    const previous = this.identityByContact[contact];
    if (previous === identity) return false;
```
`verifySenderIdentity` при промахе делает `refreshContactDevices(..., true)` (`e2e.ts:840`)
раньше, чем `sync.ts:676-678` вызовет `rememberContactIdentity`. Desktop это учёл
(`e2e.cpp:1011-1015`, `g_seenIds`).

**P-05.** `web/telegram-tt/src/api/parvane/messages.ts:199-205`:
```ts
      const content: WireMessageContent = {
        kind: 'encrypted',
        ciphertext: primary.ciphertext,
        ctype: primary.ctype,
        sender_identity: sealed.senderIdentity,
        sender_signing_key: engine.signingKey,
```
`sync.ts:484-486`: `sendAck(messageId, sealedSender)` кладёт `sender: sealedSender` в
серверный ack; messenger логирует `Ack: {} получил {}` (`main.rs:1543`). Оба ключа
опубликованы в каталоге под username (`identity.prekeys.publish`).

**P-06.** `backend/shards/identity/src/main.rs:1038-1041` (образец всех token-обработчиков):
```rust
    let verify = |token: &str| -> Result<String> {
        let data = decode::<Claims>(token, decoding, &Validation::new(Algorithm::HS256))
            .context("неверный или просроченный JWT")?;
        Ok(data.claims.sub)
    };
```
`is_device_revoked` (`:2161-2171`) вызывается только из `handle_verify` (`:2131`).
`store_prekeys(pool, &username, &req)` (`:1045`) пишет `req.device_id` с `ON CONFLICT
(username, device_id) DO UPDATE SET signing_key=…, identity_key=…` (`:577-580`), `claims.dev`
не сверяется; то же `poll_link(pool, &username, &req.device_id)` (`:990`). Gateway верифицирует
токен один раз (`gateway/src/main.rs:408-412`), подписки живут до отключения (`:557-582`);
`handle_device_revoke` (`identity:782-812`) публикует только reply.

**P-07.** `backend/shards/identity/src/main.rs:1382-1391`:
```rust
    sqlx::query("UPDATE users SET tg_2fa = ? WHERE username = ?")
        .bind(enabled as i64)
    ...
    if !enabled {
        let _ = sqlx::query("DELETE FROM login_links WHERE username = ?")...
        let _ = sqlx::query("DELETE FROM trusted_devices WHERE username = ?")...
```
Единственная аутентификация — `decode::<Claims>` (`:1364-1365`). Смена пароля: grep по
`password` в identity не находит ни одного обработчика change/reset.

**P-08.** `backend/shards/cloud/src/main.rs:144-152,161-167` и квота `:223-227`:
```rust
      sqlx::query("INSERT OR IGNORE INTO uploads (file_id, owner, total_chunks, created_at) VALUES (?, ?, ?, ?)")
  ...
      sqlx::query("INSERT OR REPLACE INTO chunks (file_id, chunk_index, data) VALUES (?, ?, ?)")
  ...
          sqlx::query_as("SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE owner = ?")
```
`DELETE FROM chunks` в файле отсутствует; `DELETE FROM uploads` — только при complete (`:266`).

**P-09.** `backend/shards/messenger/src/main.rs:212-231`:
```rust
        "INSERT OR IGNORE INTO messages
           (id, from_user, to_user, text, kind, content, ts, created_at, reply_to, updated_at)
    ...
    .execute(pool).await.context("сохранение сообщения")?;
    store_device_copies(pool, &ev.id.to_string(), &ev.payload.copies).await?;
```
`rows_affected` не проверяется; `handle_send` (`:1475-1496`) после этого строит `StoredMessage`
из события атакующего и вызывает `deliver_message`. Sync: `ORDER BY m.rowid LIMIT 100`
(`:1097-1098`), `nc.publish(reply, json)` (`:2229-2230`); лимита на `ciphertext` в
`store_message` нет; `max_payload` в `infra/nats/server*.conf` не задан (дефолт 1 МиБ).

**P-10.** `backend/shards/messenger/src/main.rs:1085-1092`:
```sql
         WHERE (m.to_user = ? OR m.from_user = ?
                OR m.to_user IN (SELECT group_id FROM group_members WHERE member = ? AND role != 'banned')
                OR COALESCE(json_extract(m.content, '$.sender_signing_key'), '') IN (SELECT value FROM json_each(?))
                OR EXISTS(SELECT 1 FROM message_device_copies c WHERE c.message_id = m.id
                           AND c.signing_key IN (SELECT value FROM json_each(?))))
```
Доказательство владения ключом требуется только для edit/delete/react/sync (`:342-379,411-416`),
при send (`:1464-1472`) sealed-путь ничего не проверяет.

**P-11.** `backend/shards/identity/src/main.rs:104-105`:
```rust
    let encoding = EncodingKey::from_secret(&secret);
    let decoding = DecodingKey::from_secret(&secret);
```
`:1097-1110` — `SELECT bytes FROM secret WHERE id = 1` / `INSERT INTO secret`; все `decode` с
`Algorithm::HS256`. `push/src/main.rs:103`: `INSERT INTO vapid_keys (id, private_pem, …)`.
`scripts/backup_server_dbs.sh:39`: `sqlite3 "$db" ".backup '$out'"` без шифрования и `umask`.
README («JWT на Ed25519») не соответствует коду.

**P-12.** `android/app/src/main/java/org/parvane/app/MainActivity.kt:19-23`:
```kotlin
        intent?.getStringExtra("gateway")?.takeIf { it.isNotBlank() }?.let { Client.gatewayUrl = it }
        DevHooks.autologin = intent?.getStringExtra("autologin")
        DevHooks.autosend = intent?.getStringExtra("autosend")
```
`AndroidManifest.xml:9` `android:usesCleartextTraffic="true"`, `:12` `android:exported="true"`;
`ParvaneViewModel.kt:61-66` исполняет `autosend` (`sendText`). Гейта по `BuildConfig.DEBUG` нет.

**P-13.** `desktop/parvane-core/src/e2e.cpp:167-172`:
```cpp
void persistAccount() {
    if (g_storeDir.empty() || !g_account) { return; }
    writeFile(accountPath(), take(parvane_e2e_account_pickle(g_account)));
```
`backend/shared/parvane-e2e/src/lib.rs:28-31` — `pickle_json` = `serde_json::to_string(&self.0.pickle())`
(без ключа). `parvane_client.cpp:1503-1511` — `SaveSessionCreds` пишет адрес и JWT plain
`QFile`; `:1534` `parvane-dec-cache.jsonl`. Android: `parvane_jni.cpp:246-249` `saveSession()`
`{"self","token"}`, `:239-244` dec-cache.

**P-14.** `web/telegram-tt/src/api/parvane/connectionController.ts:141-147`:
```ts
  function writeTrustSecret(user: string, secret: string) {
    try {
      if (secret) localStorage.setItem(trustMirrorKey(user), secret);
```

**P-15.** `backend/infra/telegram-bot/parvane_tg_bot.py:101-102`:
```python
    try:
        result = await confirm_via_gateway(token, int(sender["id"]), name)
```
`identity/src/main.rs:1737-1739`: `UPDATE login_links SET confirmed = 1 WHERE token = ?`.
Ни кнопки подтверждения, ни отображения устройства/IP.

**P-16.** `backend/infra/turn/main.go:108-127` — `turn.ServerConfig{Realm, AuthHandler,
PacketConnConfigs, ListenerConfigs}` без `PermissionHandler`; `coturn.conf:6-18` без
`no-loopback-peers`/`denied-peer-ip`, с `user=parvane:parvane`.

**P-17.** `backend/shards/push/src/main.rs:151-162` — `INSERT … ON CONFLICT(endpoint)` без
проверки `endpoint` и без cap на пользователя; `:67-76` — `handle_inbox` (HTTP-отправка) в том
же `select!`, что `register/unregister`; `:246-276` — цикл POST по всем подпискам пользователя
на каждое событие инбокса (cooldown 30 с на пользователя, `:27`).

**P-18.** `backend/shards/gateway/src/main.rs:764-774`:
```rust
fn allowed_sub(user: &str, subject: &str) -> bool {
    subject == msg_inbox(user)
        || subject == call_inbox(user)
        || subject == call_inbox(&format!("gcall:{user}"))
        || is_concrete_typing_subject(subject)
        || subject == "presence.*"
```
Web публикует `msg.typing.<peer.id>` с `{from, to}` (`messages.ts:1346`), `presence.<self>`
каждые 30 с (`connectionController.ts:355`). Подписка на `msg.typing.<hash(жертвы)>`
даёт `from` всех, кто ей пишет. (В `desktop/SECURITY-review-2026-08-22.md` помечено как
принятый компромисс — риск остаётся.)

**P-19.** `backend/shards/identity/src/main.rs:344-352`:
```rust
        let like = format!("%{}%", q);
        ...
            "SELECT username, display_name, avatar_file_id, pubkey, bio, birthday, name_color, personal_channel, phone FROM users
             WHERE (username LIKE ? OR display_name LIKE ?) AND username LIKE ? ORDER BY username LIMIT 20",
```
`handle_search`/`handle_resolve` не читают токен (`:333-340`, `:514-518`); через gateway —
только после auth (`gateway:423-428`).

**P-20.** `gateway/src/main.rs:431-432` — `inject_client_ip` только в pre-auth ветке; post-auth
`bind_client_payload` (`:752-756`) добавляет только `token`/`from`; `IDENTITY_ISSUE`/`REGISTER`
есть в `GATEWAY_ALLOWED_REQUEST` (`topic_contract.rs:130-131`). identity: `if !req.client_ip.is_empty() && !window_rate_ok(...)` (`:1211-1215`).

**P-22.** `messenger/src/main.rs:311-317`:
```rust
async fn edit_message(pool: &SqlitePool, message_id: &str, author: &str, text: &str, now: i64) -> Result<bool> {
    let content_json = serde_json::to_string(&MessageContent::Text { text: text.to_string(), entities: vec![], webpage: None })?;
    let res = sqlx::query("UPDATE messages SET text = ?, kind = 'text', content = ?, edited = 1, updated_at = ?
```
Gateway проверяет kind только при `subject == "msg.chat.send"` (`gateway:719-730`).

**P-24.** `web/telegram-tt/src/api/parvane/blobcrypt.ts:66-70`:
```ts
// Range-дешифровка окна GCM-шифртекста БЕЗ тега: GCM шифрует данные как
// AES-CTR со счётчиком nonce||u32be(2 + блок) ...
// прогрессивного плеера; целостность целого файла проверяет decryptBlob.
```

**P-27.** `desktop/parvane-core/src/e2e.cpp:1192-1194`: `inner = {{"from", g_self}, {"content", json::parse(contentJson)}}`;
web `messages.ts:337`: `engine.groupEncrypt(toAddress, JSON.stringify(wireContent), groupEpoch)`;
web приём `sync.ts:201-203` не разворачивает `content`; tdesktop `parvane_client.cpp:5557-5559`
разворачивает только при наличии `content`.

**P-31/P-32.** `backend/infra/deploy/Dockerfile.shards:14-24` — без `USER`; `docker-compose.yml:14-15`
`volumes: - db:/data` в `x-shard-common`. `Caddyfile:33-47` — только `Cache-Control`;
`vite.config.ts:290` `connect-src 'self' wss://*.web.telegram.org blob: http: https: ws: wss:`.

**P-33.** `gateway/src/main.rs:557-582` — ветка `"sub"` без `rate.allow` и без счётчика;
`:496`/`:526` — `timeout_ms` из кадра без верхней границы; `reqmany` держит NATS-подписку
до тишины (`:603-615`).

**P-38.** Все шарды: `let db_url = format!("sqlite://{}?mode=rwc", db_path); SqlitePool::connect(&db_url)`
(`identity:90-92`, `messenger:48-49`, `cloud:37-38`, …); `grep -rni pragma backend/shards` — пусто.

### 2.3. Требует проверки живьём (не подтверждено чтением)

- **Push:** возможная паника шарда при `endpoint` без схемы внутри
  `VapidSignatureBuilder::from_pem`/`build()` (`push/src/main.rs:283-286`) — нужен запуск с
  подпиской `{"endpoint":"x"}`; исходник `web-push 0.10.4/src/vapid/builder.rs:278-284` явной
  паники не показывает, но `build()` парсит URL ниже по стеку.
- Фактический `max_payload` NATS в проде (в конфигах не задан) — для P-09/P-52.
- Поведение nats-server при CRLF/пробеле в subject (P-01) — по протоколу инъекция; нужен
  стенд для подтверждения полной цепочки до клиента.
- Runtime-интероп групп web↔desktop/android (P-27).
- Покрывает ли паскод tdesktop файлы `tdata/parvane-*` (по способу записи — нет).
- Реальные значения env на проде (`PARVANE_LOGIN_RATE_*`, `TURN_USER`, `SMTP_HOST`,
  права `~/parvane/backups/`).
- `cargo audit`/`govulncheck` (нет в песочнице; версии — по `Cargo.lock`/`go.mod`).
- Обработчик `tg:`/`ton:` deep-link при клике по `text_url` в Parvane-сборке tt (P-44).

---

## 3. Матрица по пунктам задания

| # | Пункт | Вывод | Где |
|---|---|---|---|
| 1 | Изоляция на gateway | **проблема** | Свой инбокс/`call.user` — ок (`gateway:764-767`), wildcard `>`/`*` кроме `presence.*` — запрещены, служебные `identity.*`/внутренние — не в allowlist (`topic_contract.rs:113-176`, тест `topic_acl_contract` зелёный). Но: typing любого чата и presence всех (P-18); JWT-exp/revoke посреди соединения не рвут сессию (P-06); `sub` без лимита (P-33); `to` не валидируется → P-01 |
| 2 | Авторизация в шардах | **проблема** | Все атрибутированные обработчики messenger/cloud/call/notes/calendar/push зовут `identity.token.verify` и берут субъект из токена (messenger `:1466…2154`, cloud `:302-316`, call `:243-246`, notes `:96-256`, calendar `:95-210`); identity — из `claims.sub`. Но: `device_id` не привязан к `dev` (P-06); повтор `id` и чужой `signing_key` (P-09/P-10); plaintext через edit (P-22); sealed без verify (P-40) |
| 3 | Cloud | **проблема** | ACL владелец/грант/`*` на download — ок (`cloud:302-316`), `file_id: Uuid`, BLOB в SQLite (traversal невозможен), `file.list` только owner. Но: незавершённые аплоады (P-08), download в памяти (P-28), нет удаления, имя файла открыто (P-29), лимиты (P-52) |
| 4 | Identity | **проблема** | argon2id + соль, анти-энумерация с dummy-хэшем (`:1225-1236`), коды 6 цифр/900 с/5 попыток атомарно, OTK выдаётся атомарно `UPDATE…RETURNING` (`:657-668`), link-грант одноразовый с TTL — ок. Но: HS256-секрет в БД (P-11), revoke (P-06), 2FA/lock-out по одному JWT (P-07), бот без согласия (P-15), OTK-исчерпание (P-21), IP-лимит обходится (P-20), поиск (P-19), нет политики пароля/смены пароля (P-43) |
| 5 | Криптография | **проблема** | Nonce/ключ на файл из CSPRNG и проверка тега GCM — ок (`blobcrypt.ts:36-63`, `blobcrypt.cpp:20,93-105`); Megolm-ротация при исключении/бане и анти-откат по epoch — ок (`e2e.ts:876-888,956`, `e2e.cpp:1229-1235`); ключи в логах не найдены (кроме Android-текста). Но: P-02, P-03, P-04, P-05, P-24, P-25, P-26, P-27, P-36, P-39, P-48 |
| 6 | Инъекции и парсинг | **проблема** | SQL параметризован во всех шардах; `unwrap/expect` на вводе в проде отсутствуют (кроме `parvane-e2e` FFI, P-47); кадр ≤ 4 МиБ. Но: инъекция в NATS-subject (P-01); лимиты размеров (P-09, P-35, P-37, P-52) |
| 7 | Preview | **ок с оговорками** | Схемы/порты/резолв всех адресов/пиннинг IP/ручные редиректы/256 КиБ/только html — ок (`preview:297-372`). Оговорки: последовательный цикл (P-30), OSM-тайлы и координаты (P-23), пробелы deny-листа и прокси (P-49) |
| 8 | Звонки | **проблема** | `signer == from`, участник/направление/state machine, история только своя, TURN-REST HMAC с TTL — ок (`call:147-170,209-218,355-391`). Но: `to` в subject (P-01), спам Invite (P-35), TURN без фильтра peer (P-16) |
| 9 | Клиенты | **проблема** | Web: JWT в памяти, пароль/pickle/история в шифрованном IDB, нет innerHTML в нашем коде, `javascript:` нейтрализуется — ок. Но: P-12, P-13, P-14, P-44, P-45, P-46; правил MAP-1/PACK-1 в `conformance/` нет (только SYNC-1/2, PROFILE-1, READ-1, FAIL-1) |
| 10 | Инфраструктура | **проблема** | Реальных секретов в дереве и истории git не найдено (grep по ключам, токенам, `.env`, pickaxe); NATS 4222 и TCP 9223 наружу не опубликованы (только Caddy 80/443); prod-ACL без `client`/`dev`. Но: P-11, P-16, P-31, P-32, P-50, P-51 |

---

## 4. Архитектура и качество кода

Приоритет: (1) важно, (2) желательно, (3) косметика.

1. (1) **Валидация адресов отсутствует как класс.** Ни gateway, ни `parvane-types` не имеют
   типа/функции «адрес пользователя»; каждый шард получает `String`. Это корень P-01, P-52,
   части P-34. Нужен `Address` с `FromStr` (allowlist символов, `local@domain`, длина) и
   применение на gateway до publish.
2. (1) **Литералы топиков в gateway** (`gateway:150,701,719,735,754,773,780`) и в push (`:219`),
   call (`"gcall:"` `:86,122`) — правила sealed/actor-binding завязаны на строки, тест контракта
   проверяет только `subscribe(`. В messenger/остальных — константы. Web централизован в
   `wire.ts:145-197`; desktop — один литерал `call_client.cpp:15`.
3. (1) **README расходится с кодом:** «JWT на Ed25519» (HS256), «sealed sender — сервер не
   знает отправителя» (P-05), «ротация ключа при удалении участника» — есть, но не при выходе
   по времени/числу сообщений.
4. (1) **Три реализации протокола разъехались:** формат Megolm-plaintext (P-27), верификация
   автора групп (tdesktop — wire `from`, web — inner без unwrap, Android — inner.from), дефолт
   `ctype` (web 0, desktop 1), экспорт/импорт бэкапа (desktop без `sessions/groupOut`, web —
   полная замена состояния), TOFU (desktop `g_seenIds`, web — нет). `conformance/` покрывает
   только sync/read/profile; крипто-правил нет.
5. (1) **Однопоточные циклы шардов** (`select!` + `await` обработчика): identity (argon2
   inline, `:140-143`), cloud (download в памяти), preview (сеть), push (HTTP). Любой медленный
   запрос стопорит всех. Нужен `tokio::spawn` + семафор на обработчик.
6. (1) **SQLite без WAL/busy_timeout** во всех шардах (P-38); OPERATIONS.md и backup-скрипт
   предполагают WAL.
7. (2) **Монолитные `main.rs`:** identity 3153, messenger 3498 строк (тесты внутри с `:2181`/
   `:2254`); крупнейшие функции `gateway::serve` ~210 строк, `identity::do_register` ~141,
   `do_issue` ~133, `messenger::fetch_missed_with_keys` ~129. Разбить на `handlers/`, `db/`,
   `auth/`.
8. (2) **Тесты:** нет ни одного интеграционного теста с NATS в cargo; push — 0 тестов;
   `messenger/tests/ge_parse.rs` — один serde-тест. Не покрыты: чужой/просроченный токен на
   уровне обработчика, повтор `id`, инъекция через чужой `signing_key`, plaintext через edit,
   размеры payload, TTL инвайтов, subject-инъекция, revoke посреди сессии, `unknown`-вердикт,
   кросс-клиентские группы. Web-тесты (`e2e*.test.ts`, `conformance.test.ts`) в песочнице не
   запущены (lockfile/git-deps).
9. (2) **Персистентность:** у каждого шарда своя SQLite и миграции — ок; но один docker-том
   на всех (P-31), нет GC (`inbox_queue`, незавершённые аплоады, `previews`, `map_tiles`,
   `hidden_messages`, `login_links`).
10. (2) **Ошибки → клиенту как `anyhow` текст** (cloud `:456,527`, push `:172,206`) — утечка
    имён таблиц/констрейнтов; нужны коды.
11. (2) **Зависимости:** `web-push 0.10.4` тянет `jwt-simple→rsa 0.7.2` (RUSTSEC-2023-0071) и
    `openssl` (второй TLS-стек), `reqwest 0.11`/`hyper 0.14`/`rustls 0.21` в preview; 4 версии
    `base64`, 2 `rustls`, 2 `hyper`. Web: `@matrix-org/olm` deprecated; `package-lock.json` не
    синхронизирован с `package.json`; `npm audit --omit=dev` — 0 уязвимостей.
12. (2) **`npm run web:release:production`** делает `git commit -a … && git push` из скрипта
    (`package.json:18`) — сборка коммитит в репо; `postversion` — `commit --amend`.
13. (2) **Dev-хуки в прод-коде:** `PARVANE_AUTOLOGIN/AUTOSEND/AUTOLINK_GRANT/WSS_INSECURE`
    (desktop), Intent-extras и `/data/local/tmp/parvane-gateway` (Android) — без compile-time
    гейта.
14. (3) `Mutex::lock().unwrap()` в rate-limit identity (`:1978,1986,1994`) — отравленный мьютекс
    валит логин навсегда; `unreachable!()` в call (`:169`) на пользовательском enum.
15. (3) Прод-IP/SSH-порт/логин в `deploy.sh`, `OPERATIONS.md`, `tgx_build_upload.sh`; базовые
    образы без пина; нет `healthcheck`; `.env.example` NATS без preview/push.
16. (3) TODO/FIXME/XXX в backend, `web/.../parvane`, `parvane-core` — 0; `#[allow(dead_code)]` — 0.
    Мёртвого кода не обнаружено, кроме `pending_for` в messenger (используется только в тестах)
    и колонки `group_invites.revoked` без обработчика.

---

## 5. Предлагаемый порядок исправлений

**Волна 1 — закрыть периметр (дни):**
1. P-01: тип `Address` в `parvane-types`, проверка на gateway для `to` во всех event-subject'ах
   (`msg.chat.send`, `call.signal`), `is_valid_subject` в шардах перед `publish`; тест
   контракта на subject-инъекцию.
2. P-02: Android — автор групп = wire `from`, verifySender для групп, SKDM только с identity
   конверта (перенести логику из tdesktop `prepareIncoming`).
3. P-06/P-40: общая `verify_jwt(token) -> Claims` в identity с проверкой отзыва; сверка
   `req.device_id == claims.dev`; gateway — периодическая ре-верификация токена (например,
   каждые 5 мин и при `exp`) с разрывом сессии; messenger — verify и для sealed.
4. P-07/P-15/P-43: пароль (или свежий login_token) для twofa-off/revoke/setkey; кнопки
   «Подтвердить/Отклонить» в боте с показом устройства; endpoint смены пароля; политика пароля.
5. P-08/P-09/P-52: cloud — чанки в квоте + GC незавершённых; messenger — `rows_affected`,
   лимит байт на ciphertext/копию, страница sync по байтовому бюджету, `max_payload` в
   конфиге NATS с запасом.
6. P-11: JWT-секрет и VAPID из env/файла 0600, ротация по `kid`; бэкапы через `age`, `umask 077`.
7. P-12/P-46: Android — Intent-extras и файл-оверрайд только в debug, `wss://`-only,
   `usesCleartextTraffic=false`, убрать текст из logcat, релизный keystore.

**Волна 2 — криптография и приватность (недели):**
8. P-03: линковка — SAS от обоих эфемерных ключей с commitment (или PAKE), ≥ 40 бит; не
   переносить приватный Olm-аккаунт (P-48).
9. P-04: web — отдельное множество виденных identity (как desktop), предупреждение о новом
   устройстве; P-25 — проверка `signed_prekey_sig`; P-26 — `unknown` = не показывать.
10. P-27/P-13: зафиксировать формат Megolm-plaintext в `conformance/` с тестом в каждом
    клиенте; шифровать `tdata/parvane-*` и Android `files/` ключом из keychain/Keystore.
11. P-05: либо честно переименовать «sealed sender» в README, либо внешний ECIES-слой + ack
    без `sender`; P-10 — подпись `send:<id>:<ct>`; P-22 — только E2E-kind при edit.
12. P-14/P-39: `trust_secret` и пароль — в `SecureE2eStorage` с опциональным PIN.
13. P-18/P-19/P-29/P-42: typing/presence по членству/контактам; поиск с `ESCAPE` и без
    телефона; непрозрачные имена файлов; логи без адресов.

**Волна 3 — устойчивость и инфраструктура:**
14. P-38 (WAL), spawn+семафор в identity/cloud/preview/push (п. 4.5), P-28, P-30, P-33
    (cap подписок/таймаутов), P-17 (валидация endpoint, cap подписок), P-20/P-21/P-37 (лимиты).
15. P-16 (TURN peer-фильтр), P-31 (non-root, тома на шард, `read_only/cap_drop`), P-32
    (HSTS/frame-ancestors, `connect-src 'self' wss://<host>`), P-50/P-51 (секреты деплоя в
    env, `reqwest 0.12`, замена `web-push`, пин образов), P-36 (vodozemac-wasm).
16. Тесты: интеграционные с NATS для gateway↔identity↔messenger (чужой токен, чужой subject,
    revoke посреди сессии, subject-инъекция, повтор id); push — хотя бы unit; синхронизация
    `package-lock.json` и прогон vitest в CI.

---

## 6. Статус исправлений (ветка `security-review-fixes`, 2026-09-27)

Столбец «Статус» в таблице 2.1 — коммит и способ проверки каждой находки.
Пункты раздела 4 с приоритетом (1)/(2):

| Пункт | Статус |
|---|---|
| 4.1 валидация адресов | исправлено в 8d4fbc9a (`Address`, `is_valid_subject_token`) |
| 4.2 литералы топиков | исправлено в 880d7926 (константы/хелперы в parvane-types, зеркала topics.h и wire.ts, conformance-проверка на литералы) |
| 4.3 README расходится с кодом | исправлено в 0af4c8b7 и финальном коммите документации |
| 4.4 три реализации разъехались | исправлено правилами E2E-1, LINK-1, KEY-1, SEND-1, EPHEMERAL-1, BLOB-1 в `conformance/` с тестами в каждом клиенте |
| 4.5 однопоточные циклы | исправлено в e401ef57 (`tokio::spawn` + семафор, `PARVANE_HANDLER_CONCURRENCY`) |
| 4.6 SQLite без WAL | исправлено в e401ef57 (`parvane-db`) |
| 4.7 монолитные main.rs | исправлено в cdb93f79, 239b961c, 6c3ca49b (identity, messenger, gateway по модулям; `serve` не дробился — частично) |
| 4.8 тесты | исправлено в ed96a950 (`parvane-integration` с живым NATS), push unit-тесты в f9605fe5, C++ live-тесты в 01a551ee |
| 4.9 персистентность/GC | исправлено в f9605fe5 (тома на шард, GC надгробий/очереди), 496beae8 (GC аплоадов), 01a551ee (кап тайлов) |
| 4.10 ошибки как текст | исправлено в 880d7926 (`parvane_db::public_error`) |
| 4.11 зависимости | исправлено в f9605fe5 (см. P-51) |
| 4.12 git из npm-скрипта | исправлено в 880d7926 |
| 4.13 dev-хуки | исправлено в 724c09b2 (`PARVANE_DEV`/debug-гейты) |
| 4.14 мьютексы/unreachable | исправлено в 880d7926 |
| 4.15 прод-данные в репо, пины, healthcheck | частично: f9605fe5 (секреты деплоя в `.deploy.env`, `.env.example`); пины образов и healthcheck не добавлялись |

Не выполнено в облачной среде (нужна рабочая машина): сборка tdesktop
(`-j6`) и Android (Gradle/эмулятор) — изменения в `parvane_client.cpp`,
`parvane_jni.cpp`, Kotlin проверены только чтением и через общий код
parvane-core; `desktop/verify_*.sh`, `tgx_*_flow.sh`, браузерные
`e2e_web_*.mjs` (нужен `npm ci` с git-зависимостью `emoji-data-ios`) и
деплой NATS-конфигов/`deploy.sh`. Живые проверки, которые выполнены:
`scripts/e2e_smoke.py`, `e2e_cloud.py`, `e2e_call.py`, все live-бинарники
parvane-core и `cargo test -p parvane-integration` на стеке из nats-server и
шардов.

