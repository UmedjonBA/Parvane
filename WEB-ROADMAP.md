# Parvane Web: проверка, безопасность и развитие

Статус документа: план выполнен, обновлено 2026-08-10. Ниже — итог; исходный
план сохранён как история и методология.

## 0. Итог выполнения (2026-08-10)

- **Этап A закрыт полностью** (все 16 строк `WEB-A4-MATRIX.md`).
- **Этап B закрыт полностью**: B1 медиа (голос/кругляши/видео/аудио),
  B2 звонки (1-1 + групповые mesh + TURN + устойчивость), B3 группы
  (роли/промоут/каналы/live-конвергенция/mention badge), B4 UX (Saved
  Messages, черновики, shared media, архив/пины, превью ссылок — шард
  `preview`, стикер-паки PVPK1, web-push — шард `push`, a11y/responsive).
  Quality gate B пройден: ~15 e2e-сценариев зелёные.
- **Сверх плана** (батч «все 7», 2026-08-09): TTL-матрица всего контента,
  опросы (quiz + public voters), GIF-панель с персистом, инвайт-ссылки групп,
  бэкапы (SQLite шардов + экспорт/импорт E2E-ключей = перенос устройства),
  настоящий web-push (VAPID).
- **Баг-батч ручного теста (2026-08-10)**: read-статус групп per-requester,
  self-чат для «Избранного», персист настроек без MTProto-кэша, рабочий мьют
  (+notify defaults), локализация меню, вычистка Telegram-инфраструктуры из
  UI (Premium/Stars/Gram/FAQ/жалобы/подарки/Active Sessions/Language/…).
- **Мультидевайс-ядро СДЕЛАНО (2026-08-14, коммит 6d4626dd)**: per-device
  прекей-бандлы в identity (devices + signing_key устройства, known_devices
  не расходуют one-time), per-device sealed-копии в messenger
  (`message_device_copies`, подмена шифртекста в sync по `device_id`,
  self-копии по signing-ключу целевого устройства, копии в live-пуше,
  правка/удаление обновляют копии), Web-движок с `deviceId` и fan-out
  шифрованием на все устройства получателя и свои устройства, SKDM-fan-out
  в группах. Свежий логин больше НЕ перетирает identity других устройств;
  wire-контракт с desktop обратно совместим (desktop = устройство '').
  e2e: `scripts/run_web_multidevice_e2e.sh` (3 браузера, один аккаунт на
  двух устройствах) + регрессии keys_backup/groups/cross_client/sync зелёные.
- **Settings→Devices СДЕЛАНО (2026-08-17)**: `identity.device.list/revoke`
  во всех слоях контракта (листинг с остатком one-time prekeys без расхода,
  отзыв только своих устройств по JWT); нативный экран Active Sessions
  кормится нашими устройствами (пункт «Devices» в настройках), отзыв ротирует
  Megolm своих групп, исчезновение устройства контакта из каталога ротирует
  общие группы; прогрев каталогов до выбора группового ключа (иначе ротация
  посреди SKDM ломала эпоху). Плюс: пополнение one-time prekeys на логине
  (порог 5, персистентный счётчик key_id), PBKDF2 экспорта 600k, wss:// на
  https. e2e: `scripts/run_web_devices_e2e.sh` (3 браузера).
- **Авто-линковка истории СДЕЛАНА (2026-08-17)**: identity.link.offer/poll/
  grant (эфемерный ECDH P-256, SAS-код, экспорт шифртекстом через cloud,
  одноразовый грант, TTL 15 мин, отзыв оффера пустым eph_pub); импорт —
  слияние (decCache + входящие Megolm + legacy-подписант), своя identity
  сохраняется; sealed-исходящие прежних устройств — через extra_signing в
  sync (messenger проверяет подписи, cap 8). UI — в Settings→Devices (код
  ожидания на новом, запросы с подтверждением на старом). Плюс фикс
  requestSync (сброс chats.isFullyLoaded — ресинк после импорта был no-op).
  e2e: `scripts/run_web_linking_e2e.sh`; крипто — vitest linking.test.ts.
- **Остатки мультидевайса**: fan-out в desktop-клиенте, Devices-экран и
  линковка в desktop.
- **Следующее большое**: деплой на VPS — деплой-комплекта в репо ещё нет
  (systemd-юниты шардов, nginx/caddy + TLS, .env-шаблоны, файрвол, TURN).
  Оценка железа для старта: 2 vCPU / 4 ГБ / 80 ГБ NVMe; сборка веба и шардов
  — не на VPS (нужно 4+ ГБ), заливать готовые бинари и dist.

Регрессионный набор: `scripts/run_web_tests.sh` (по сценарию за раз — см.
CLAUDE.md), юнит-тесты `npx vitest run` в web/telegram-tt, `cargo test`.

Цель: сделать `web/telegram-tt` основным клиентом Parvane и развивать его в
строгом порядке:

1. Проверить и исправить текущую реализацию Web.
2. Достичь функционального и криптографического паритета с desktop-клиентом.
3. Реализовать функции, которых пока нет ни в Web, ни в desktop.

`desktop/PARITY-telegram.md` остаётся историей и инвентарём desktop-клиента.
Этот файл является источником истины для приоритетов Web. Архитектурные решения
и wire-контракты по-прежнему описываются в `ARCHITECTURE.md`, `ROADMAP.md` и
`specs/`.

## 1. Обязательные правила

1. Этапы выполняются только по порядку. Новый функционал не начинается, пока
   quality gate предыдущего этапа не зелёный.
2. Web является основным клиентом. Общий backend-контракт нельзя менять без
   проверки совместимости с desktop.
3. Безопасность работает fail-closed. Ошибка E2E не должна молча переключать
   чат на plaintext.
4. Функция считается готовой только при наличии автоматической проверки её
   основного сценария и критичных отказов.
5. Ручная проверка дополняет автоматическую, но не заменяет её.
6. Исправление протокола включает одновременно Rust-типы, gateway, ACL, Web,
   desktop-совместимость, миграцию и тесты.
7. В production не допускаются dev-логины, широкие NATS wildcard-права,
   plaintext transport, тестовые секреты и логирование токенов/ключей.
8. После каждого законченного блока рабочее дерево должно проходить единый
   регрессионный прогон.

## 2. Что считаем ошибкой

В этап A входят не только падения UI. Ошибкой считается любое из следующего:

- нарушение заявленного E2E или изоляции пользователей;
- потеря, дублирование, неправильный порядок или неверная адресация сообщений;
- несовместимость Web и desktop на общем wire-контракте;
- функция, которая видна в UI, но работает только частично;
- некорректное восстановление после reload, reconnect, offline или второго tab;
- расхождение dev и production-конфигурации;
- незелёная сборка, lint или тестовый набор;
- отсутствие ограничений на недоверенный ввод и размеры данных;
- утечка секрета, plaintext, персональных данных или лишних метаданных в лог;
- непроверенная деградация, замаскированная fallback-поведением.

## 3. Этап A: проверка и исправление текущего Web

Во время этапа A новые пользовательские функции не добавляются. Допустимы
только исправления, тестовая инфраструктура и рефакторинг, необходимый для
надёжности проверяемого поведения.

### A0. Зафиксировать baseline и quality gate

Задачи:

- Исправить все текущие ошибки `npm run check:ts` и `npm run check:css`.
- Восстановить Vitest setup `web/telegram-tt/tests/init.ts` и сделать
  `npm test` рабочим с чистого checkout.
- Проверить production-сборку, mocked-сборку и загрузку Olm WASM.
- Добавить единый Web-runner, который запускает lint, typecheck, unit,
  integration, build и Playwright.
- Включить Web-runner в общий `scripts/run_all_tests.sh` либо создать
  вызываемый им `scripts/run_web_tests.sh`.
- Разделить тесты на unit, protocol/contract, integration и browser e2e.
- Зафиксировать поддерживаемые браузеры: Chromium, Firefox, WebKit и мобильный
  viewport. Реальные media/call тесты можно выполнять отдельным Chromium job.
- Запретить merge при красном обязательном job.

Обязательные команды после A0:

```bash
cargo test --workspace
cd web/telegram-tt
npm ci
npm run check
npm test
npm run build:production
npm run test:playwright
```

DoD A0:

- Все команды завершаются с кодом 0 на чистом checkout.
- Тесты не требуют существующей пользовательской БД или случайно запущенных
  локальных процессов.
- Временные NATS, шарды, БД и браузеры всегда завершаются после теста.
- Для каждого падения сохраняются читаемые логи, screenshot и trace.

### A1. Инвентаризация поведения и contract tests

Задачи:

- Составить таблицу всех методов, которые Telegram-TT вызывает через
  `callApi`: реализован, намеренно отключён или отсутствует.
- Убрать молчаливые заглушки критичных методов. Неизвестный обязательный метод
  должен давать наблюдаемую ошибку в dev/test.
- Сверить TypeScript wire-типы и topic-константы с `parvane-types`.
- Добавить contract tests сериализации для каждого message kind, mutation,
  group operation, call signal и identity request.
- Проверить обратную совместимость сообщений, созданных desktop-клиентом.
- Добавить тест, который сравнивает подписки Rust-шардов, allowlist gateway и
  оба NATS-конфига. Любой отсутствующий subject должен ломать тест.
- Зафиксировать максимальные размеры frame, сообщения, имени, caption,
  вложения, группы, poll и batch sync.
- Ввести строгую проверку входных WebSocket JSON-кадров и wire-payload. Один
  битый frame не должен ронять соединение или шард.

DoD A1:

- Все используемые методы и topics учтены в автоматической инвентаризации.
- Dev и production ACL соответствуют реальным подпискам и публикациям.
- Web принимает все поддерживаемые сообщения desktop и наоборот.
- Неизвестные kind и некорректные payload обрабатываются предсказуемо.

### A2. Надёжность клиента

Проверить и исправить:

- первый логин, повторный логин, logout и неверный пароль;
- явную регистрацию вместо регистрации после любой ошибки login;
- initial sync, delta sync, pagination и восстановление курсоров;
- live inbox, ack, offline queue и повторную доставку;
- дедупликацию UUID и идемпотентность mutation;
- сообщения и mutation, пришедшие не по порядку;
- reconnect gateway и перезапуск каждого шарда;
- reload во время upload/download и во время отправки сообщения;
- два tab одного аккаунта и одновременное редактирование локального состояния;
- заполненный или недоступный storage, повреждённые записи и миграцию формата;
- большие истории без полного sync и без неограниченного роста памяти;
- URL media cache, освобождение Blob URL и отмену запросов;
- schedule queue при смене времени, sleep и нескольких tab;
- polling, stickers, GIF, custom emoji, folders и blocked list после reload;
- ошибки камеры, микрофона, WebRTC, cloud и недостаток permissions;
- доступность основных операций с клавиатуры и mobile viewport.

Рефакторинг после фиксации behavior tests:

- Разделить `src/api/parvane/provider.ts` по доменам: auth/connection, sync,
  messages, media, groups, calls и local state.
- Оставить в provider только композицию методов и отправку `ApiUpdate`.
- Не менять поведение одновременно с механическим переносом кода.

DoD A2:

- Два браузера стабильно обмениваются текстом и медиа после offline/reconnect.
- Повторная доставка не создаёт дубликатов.
- Reload не теряет подтверждённое локальное состояние.
- Нет известных бесконечных таймеров, подписок и растущих media cache.
- `provider.ts` больше не является единственной точкой всей доменной логики.

### A3. Security audit и исправления

#### A3.1 Gateway и NATS

- Запретить клиентские подписки на произвольный `_INBOX.*` и особенно
  `_INBOX.>`. Reply inbox создаёт и обслуживает только gateway.
- Добавить негативные тесты wildcard: `>`, `*`, `_INBOX.>`, `msg.user.>`,
  чужие `msg.user.*` и `call.user.*`.
- Привязать каждую операцию к пользователю авторизованного WebSocket. Нельзя
  доверять `from`, `user`, `owner` или `token` из клиентского payload.
- Gateway должен переписывать identity-поля либо проверять их до публикации.
- Запретить spoofing typing/presence и подписку на лишние presence subjects.
- Синхронизировать `server.conf` и `server.prod.conf` с identity prekeys и
  group moderation subjects.
- Добавить origin allowlist, connection/frame/rate limits и idle timeout.
- Production gateway работает только через WSS, NATS только через TLS.
- Проверить backpressure: медленный WebSocket не должен безгранично накапливать
  `UnboundedSender` frames.

#### A3.2 Authentication и authorization

- Login не должен автоматически вызывать register при неверном пароле.
- Identity возвращает различимые машинные error codes без утечки лишних данных
  в публичном UI.
- Проверить rate limit login/register/invite и защиту от перебора.
- Проверить срок JWT, отзыв сессии и поведение после смены пароля.
- Каждый шард самостоятельно проверяет token и соответствие actor операции.
- Проверить права на edit/delete/read/react/pin, group moderation и call
  signaling, а не только наличие валидного token.
- Проверить IDOR для cloud: знание `file_id` не должно позволять чужому
  пользователю скачать или перечислить файл без права получателя.
- Удалить токены, пароли, plaintext и key material из логов и ошибок.

#### A3.3 E2E текста и групп

- Удалить автоматический plaintext fallback при отсутствии prekey, ошибке Olm
  или ошибке раздачи group key. Сообщение остаётся неотправленным с понятной
  ошибкой.
- Если plaintext-чат когда-либо понадобится, это отдельный явно включённый
  режим с заметным состоянием, а не fallback.
- Реализовать replenishment one-time prekeys и безопасную fallback-key rotation.
- При смене identity key показывать предупреждение и требовать повторной
  верификации контакта.
- Добавить safety number/fingerprint UI и подтверждённое состояние контакта.
- Вызывать Megolm rotation после remove/ban участника и других изменений,
  исключающих доступ. Новый ключ раздаётся только текущим участникам.
- Проверить replay, duplicate prekey, out-of-order ratchet, старую group epoch,
  повреждённый ciphertext и сообщения после reinstall.
- Зафиксировать и протестировать поведение при потере ключей. Нельзя помещать
  неизвестный sealed sender в случайный чат как обычное сообщение.

#### A3.4 Локальные ключи и browser security

- Не хранить пароль в `localStorage`.
- Не защищать Olm/Megolm pickle общей константой из исходного кода.
- Хранить зашифрованный state в IndexedDB; ключ защиты получать через WebCrypto
  и делать non-extractable, где это возможно.
- Для режима с локальной парольной фразой использовать стандартный KDF и
  отдельную версионированную схему storage. Не писать свою криптографию.
- Описать честную browser threat model: E2E не защищает от XSS в активной
  сессии. Компенсации: строгий CSP, отсутствие inline script, минимизация
  сторонних origin, dependency pinning и проверка bundle.
- Проверить injection через display name, filename, link preview, captions,
  sticker metadata и localization.
- Проверить logout/clear data: ключи, токены, decrypted cache и Blob URL должны
  удаляться согласно выбранной политике.

#### A3.5 Медиа и звонки

- Проверить уникальность nonce и формат AES-GCM envelope для каждого blob.
- Валидировать размер, chunk count, MIME и итоговый размер файла.
- Не доверять filename/MIME при отображении и скачивании.
- Подписывать SDP identity-ключом, проверять подпись до принятия offer/answer.
- Добавить SAS/fingerprint UI звонка и блокировать звонок при ошибке проверки.
- Проверить ICE candidate injection, чужой call_id, replay сигналов и busy race.
- TURN credentials не должны быть вечными или находиться в публичном bundle.

#### A3.6 Security test matrix

Автоматические сценарии Mallory:

- подписка на inbox Alice/Bob и `_INBOX.>`;
- отправка события с чужим `from` при своём JWT;
- чтение чужого sync и cloud file по известному UUID;
- edit/delete/react от чужого пользователя;
- add/ban/mute/promote без нужной роли;
- подмена presence, typing и call sender;
- старый участник группы после rotation;
- новый device без ключей старой сессии;
- повреждённый ciphertext, nonce, media chunk и oversized frame;
- повтор offer/answer/ICE и неверная SDP signature;
- XSS payload в каждом пользовательском строковом поле.

DoD A3:

- Нет открытых Critical/High проблем в согласованной threat model.
- Клиент не может прочитать чужой NATS reply, inbox, sync или cloud blob.
- Ошибка E2E никогда не приводит к незаметной plaintext-отправке.
- Исключённый участник не расшифровывает новые групповые сообщения.
- Звонок показывает проверяемую identity и отвергает неверную подпись.
- Production transport использует WSS/TLS и минимальные ACL.
- Security regression tests выполняются в каждом обязательном прогоне.

### A4. Сквозная приёмка текущих функций

Для каждой функции нужны happy path, reload/reconnect и permission/error path:

- auth/register/logout/profile/avatar;
- personal text, format/entities, reply, edit, delete, reaction, pin, forward;
- read receipt, unread, typing, presence, search;
- photo/file upload, download, E2E и TTL;
- groups: create, add, remove, ban, mute, invite и encrypted media;
- poll create/vote/close/public voters;
- stickers, GIF, animated stickers и custom emoji;
- folders, blocked users, scheduled messages и static location;
- audio/video 1-to-1 call;
- cross-client Web to desktop и desktop to Web.

Минимальная топология e2e:

- Alice: Chromium, первый device;
- Alice-2: отдельный browser context, второй device/tab;
- Bob: Firefox или WebKit;
- Mallory: отдельный пользователь без прав;
- временные production-подобные NATS ACL, gateway и все нужные шарды.

Quality gate A:

- A0-A4 DoD выполнены.
- Все текущие функции имеют записанный статус и автоматическую проверку.
- Нет открытых P0/P1 дефектов.
- Нет незадокументированных plaintext/security fallback.
- Проект можно развернуть по production-инструкции на чистой машине.

## 4. Этап B: догнать desktop по функционалу

Этап B начинается только после quality gate A. Порядок внутри этапа выбран по
ценности основного messenger workflow и риску совместимости.

### B1. Полный media messaging

- Голосовые сообщения: запись, preview, pause/cancel, upload, native bubble,
  duration, waveform, playback и seek.
- Видеосообщения: круглая запись, preview, upload, native round-video bubble.
- Обычное видео: thumbnail, duration, progressive/range download, streaming,
  seek и fullscreen.
- Аудиофайлы: корректный audio player и metadata.
- Clipboard, drag-and-drop, caption, send-as-file и повтор отправки.
- Все виды медиа работают в личке и группах, с E2E, TTL и forward.
- Wire-совместимость каждого вида проверяется Web <-> desktop.

DoD B1:

- Web не деградирует voice/video/video_note до обычного файла.
- Запись и playback проверены в Chromium; приём проверен во всех браузерах.
- Desktop и Web взаимно воспроизводят все media kinds.

### B2. Паритет звонков

- Ed25519-подпись offer/answer и обязательная проверка.
- SAS-эмодзи/fingerprint в UI.
- Настраиваемый STUN и краткоживущие TURN credentials.
- Call history и статусы missed/rejected/ended.
- Переключение mic/camera/device, screen sharing при наличии upstream UI.
- Групповые аудио/видеозвонки mesh с явным лимитом участников.
- Reconnect, busy, simultaneous call, permission denied и network switch.

DoD B2:

- 1-to-1 звонки не уступают desktop по безопасности и основным controls.
- Групповой звонок проходит между минимум тремя Web-клиентами.
- Web и desktop совершают взаимный подписанный звонок через TURN fallback.

### B3. Группы и каналы

- Создание канала, загрузка информации и корректный channel UI.
- Promote/demote admin через `group.setrole`.
- Права owner/admin/member и гранулярные ограничения доступных действий.
- Выход из группы, удаление/переименование группы и channel posting rules.
- Mention badge и переход к упоминанию.
- Проверка member list и admin state после live update/reload.
- Все membership changes интегрированы с E2E group rotation.

DoD B3:

- Все операции desktop group admin доступны в Web.
- UI не показывает действие, которое backend гарантированно отклонит.
- Cross-client membership и роли сходятся без full reload.

### B4. Контент и ежедневный UX

- Богатые link previews через ограниченный privacy-aware backend fetcher:
  защита от SSRF, private IP, redirect loop и oversized response.
- Черновики с локальным persist и согласованной политикой нескольких tab.
- Saved Messages без ошибочного помещения неизвестных sealed messages.
- Общие медиа, профиль контакта и релевантные настройки.
- Уведомления foreground/background и permission lifecycle.
- Архив, pinned chats и корректная сортировка списка чатов.
- Пользовательские sticker packs, импорт/удаление и `pack_ref`-обмен.
- TGS/WebM compatibility там, где формат поддерживает браузер.
- Аудит accessibility и responsive layout основных messenger workflows.

Quality gate B:

- Для каждого desktop feature в отдельной parity-таблице стоит `PASS` или
  явно согласованное `OUT OF SCOPE`.
- Все `PASS` подтверждены Web-only и Web <-> desktop e2e.
- Нет функциональной деградации в security gate A.
- Desktop больше не нужен для повседневного messenger workflow.

## 5. Этап C: функции, которых нет даже в desktop

Каждый блок C получает отдельную protocol/spec-фазу до реализации. Нельзя
добавлять его только локальным Web-костылём, если состояние должно разделяться
между устройствами или пользователями.

### C1. Настоящий E2E-мультидевайс и backup

- Модель `account -> devices`, отдельная identity/prekeys каждого устройства.
- Fan-out сообщения на все активные devices получателя и собственные devices.
- QR/device linking с подтверждением на существующем устройстве.
- Список устройств, revoke и уведомление об изменении identity set.
- Корректная обработка групп и sender keys при добавлении/удалении device.
- Зашифрованный backup ключей/истории под пользовательской парольной фразой.
- Restore, смена фразы, версия backup и recovery UX.
- Миграция существующих single-device аккаунтов без plaintext upload.

DoD C1:

- Alice-1 и Alice-2 получают и расшифровывают новые входящие и исходящие.
- Revoked device не получает новые сообщения.
- Потерянное устройство восстанавливается только при наличии выбранного
  recovery secret; сервер не способен расшифровать backup.

### C2. Большие группы и обсуждения

- Треды, forum topics и discussion для каналов.
- Гранулярные admin permissions.
- Счётчики `прочитали N` и список прочитавших с privacy controls.
- Масштабирование group encryption; оценить MLS вместо бесконечного Megolm
  fan-out для больших групп.
- Server-side pagination участников, сообщений и topics.

### C3. Новые типы сообщений и realtime

- Live location с явным сроком, остановкой трансляции и permission UX.
- Contact attachment без раскрытия лишних полей адресной книги.
- Silent messages.
- Server-side scheduled messages вместо локальной browser-очереди.
- Голосовые чаты и live streams с моделью speaker/listener/moderator.

### C4. Синхронизируемое состояние приложения

- Server-side folders, drafts, archive, pinned chats и blocked users.
- Политика конфликтов между устройствами и offline merge.
- Настройки уведомлений и privacy, общие для устройств.
- Экспорт данных и удаление аккаунта.

### C5. Остальные поверхности Parvane

- Web UI календаря поверх `calendar` shard.
- Web UI заметок/дневника поверх `notes` shard.
- Общая навигация без нарушения messenger workflow.
- Reskin Parvane после стабилизации UX, если решение будет подтверждено.

### C6. Будущая сеть и клиенты

- Metadata hardening: padding size classes и минимизация timing metadata.
- Опциональный Tor transport с честно описанными ограничениями.
- Федерация bubble-to-bubble, discovery, delivery receipts и anti-spam.
- Мобильные клиенты и push после стабилизации multi-device protocol.

Quality gate C для каждого блока:

- Есть отдельная threat model и protocol spec.
- Есть миграция и rollback совместимых данных.
- Старые Web/desktop-клиенты получают понятное unsupported-состояние.
- E2E, authorization и cross-device тесты зелёные.
- Обновлены wire docs, deployment docs и recovery runbook.

## 6. Намеренно вне текущего плана

Пока пользователь явно не изменит решение, не реализуем:

- Bot API и ботов;
- mini apps;
- Stories;
- Premium-механику;
- платежи;
- smarthome.

Эти функции не учитываются при quality gate B.

## 7. Порядок первых работ

Первый исполняемый backlog:

1. `WEB-A0-001`: сделать зелёными lint/typecheck/build/Vitest.
2. `WEB-A0-002`: создать живой Web e2e harness с временными NATS/gateway/shards.
3. `WEB-A3-001`: закрыть `_INBOX.>` и добавить Mallory regression tests.
4. `WEB-A3-002`: синхронизировать production ACL с реальными subjects.
5. `WEB-A3-003`: запретить sender/presence/typing spoofing через gateway.
6. `WEB-A3-004`: удалить E2E plaintext fallback.
7. `WEB-A3-005`: подключить group rotation к membership changes.
8. `WEB-A3-006`: убрать пароль и общий pickle key из `localStorage`.
9. `WEB-A3-007`: проверить и закрыть cloud IDOR.
10. `WEB-A3-008`: подписывать звонки и добавить SAS.
11. `WEB-A1-001`: ввести topic/ACL contract test.
12. `WEB-A2-001`: покрыть sync/reconnect/idempotency двумя браузерами.
13. `WEB-A2-002`: разделить `provider.ts` после behavior coverage.
14. `WEB-A4-001`: прогнать полную матрицу текущих функций и закрыть найденное.
15. `WEB-B1-001`: начать desktop parity с голосовых сообщений.

## 8. Шаблон каждой задачи

Каждая задача перед реализацией должна содержать:

```text
ID и краткое название
Текущее поведение / угроза
Ожидаемое поведение
Затрагиваемые файлы и компоненты
Изменение wire/DB/ACL и совместимость
Unit tests
Integration/security tests
Browser e2e
Migration и rollback, если нужны
Definition of Done
```

Статус `DONE` ставится только после выполнения DoD и общего регрессионного
прогона. Частично работающая функция остаётся `IN PROGRESS`, даже если её happy
path уже демонстрируется вручную.
