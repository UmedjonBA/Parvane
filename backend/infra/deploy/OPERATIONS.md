# Parvane m60-7 — эксплуатация (шпаргалка)

Сервер: `ssh -p 2240 umejon@185.81.248.52`, всё в `~/parvane/`.
Вход для пользователей: `https://parvane.duckdns.org:20443` (пароль сайта у владельца).

Все команды ниже — из `~/parvane/` на сервере.

## Статус и логи
```bash
docker compose ps                          # что запущено
docker compose logs --tail 50 gateway      # логи одного сервиса
docker compose logs -f messenger           # хвост в реальном времени
docker compose logs --tail 30 identity messenger gateway caddy
```

## Перезапуск
```bash
docker compose restart caddy               # один сервис
docker compose restart                     # все (короткий даунтайм)
docker compose up -d                        # применить изменённый compose/.env
```
Контейнеры и так поднимаются сами (`restart: unless-stopped`) после падения/ребута.

## Регистрация (открытая, подтверждение через Telegram-бота или почту)
Пароля на сайт больше нет (снят 2026-09-05). Регистрация: ник + пароль →
экран «Confirm via Telegram» (deep link `t.me/<bot>?start=<token>`) → Start в
боте → клиент логинится сам. Бот живёт на VPS 213.155.15.139
(`backend/infra/telegram-bot`, юнит `parvane-tg-bot`, env `/etc/parvane/tg-bot.env`),
потому что с прод-сервера api.telegram.org недоступен. В `.env` identity:
```
PARVANE_TELEGRAM_BOT=Parvane_test_bot
PARVANE_TELEGRAM_SECRET=<тот же, что у бота>
```
Проверка: `journalctl -u parvane-tg-bot -f` на VPS, `docker compose logs
identity | grep Telegram` на проде.

### Двухфакторный вход (по желанию, Settings → Privacy → «Подтверждать вход в Telegram»)
Требует привязанного Telegram (после подтверждения аккаунта ботом). Вход по
паролю на НОВОМ устройстве → экран «Подтвердите вход» с deep link → Start в
боте; identity принимает Start только от `users.telegram_id`. После
подтверждения устройство (claim `dev`) доверенное (`trusted_devices`) — вход по
паролю без Telegram, пока устройство не отозвано или 2FA не выключен/включён
заново. Топик `identity.user.twofa` (JWT; `enabled` пуст — только чтение),
токены входа в `login_links` (10 мин, одноразовые). Бот отвечает «Вход
подтверждён» (поле `kind: login` в ответе identity.telegram.confirm).
Обновление бота на VPS: `scp backend/infra/telegram-bot/parvane_tg_bot.py
root@213.155.15.139:/opt/parvane-tg-bot/ && ssh root@213.155.15.139 systemctl
restart parvane-tg-bot`.

Запасной вариант — почта (когда появится SMTP): убрать PARVANE_TELEGRAM_*,
ник + почта + пароль → 6-значный код письмом. Нужны в `.env` (identity):
```
PARVANE_EMAIL_REQUIRED=1          # дефолт compose — 1
PARVANE_SMTP_HOST=smtp.example.com
PARVANE_SMTP_PORT=587             # 465 = implicit TLS, иначе STARTTLS
PARVANE_SMTP_USER=...
PARVANE_SMTP_PASS=...
PARVANE_SMTP_FROM=Parvane <noreply@example.com>
PARVANE_DOMAIN=parvane.duckdns.org   # дефолт — PARVANE_PUBLIC_HOST
```
Применить: `docker compose up -d identity`. Проверка: зарегистрировать
тестовый ник — письмо с кодом должно прийти; `docker compose logs identity`
покажет «Код подтверждения отправлен на …» (или ошибку SMTP). Без
`PARVANE_SMTP_HOST` код печатается только в лог identity (dev-режим) — на
проде так оставлять нельзя: зарегистрироваться сможет только тот, кто читает
логи.

Временно закрыть регистрацию совсем: `PARVANE_INVITE_REQUIRED=1` у identity
(коды — вручную в таблицу `invites` identity.db, UI выдачи нет) или вернуть
basic_auth в Caddyfile (архив в README, раздел «Регистрация: почта вместо
пароля на сайт»).

## Бэкапы
- Автоматом: cron `0 4 * * *` → `~/parvane/backup.sh` → `~/parvane/backups/`, хранит 14 дней.
  С 5 окт 2026 скрипт на сервере обходит тома шардов `parvane_db-<шард>` и снимает обе базы
  каждого — v1 (`<шард>-<дата>.sqlite`) и v2 (`<шард>.db-v2-<дата>.sqlite`); прежний вариант
  (общий том `parvane_db`) лежит рядом как `backup.sh.prev-20261005`. Файлы ключей в бэкап не входят.
- Вручную: `~/parvane/backup.sh`
- Проверить снимок: `docker run --rm -v ~/parvane/backups:/bak alpine sh -c 'apk add -q sqlite; sqlite3 /bak/messenger-<дата>.sqlite "PRAGMA integrity_check"'`

## Ключи подписи (P-11)

Ключ подписи JWT и приватный VAPID-ключ больше НЕ лежат в SQLite:

- `/data/identity-jwt-ed25519.pem` — Ed25519 (PKCS#8 PEM, права 0600), задаётся
  `PARVANE_JWT_KEY_FILE`; при первом старте новой версии старый HS256-секрет
  переносится из `identity.db` в `/data/identity-jwt-ed25519.legacy-hs256` и
  принимается ещё 24 ч (срок жизни выданных токенов), затем файл удаляется.
- `/data/push-vapid-p256.pem` — VAPID (P-256, PKCS#8 PEM, 0600),
  `PARVANE_VAPID_KEY_FILE`; при первом старте переносится из `push.db` (публичный
  ключ тот же — подписки браузеров не теряются).

Бэкапить эти файлы ОТДЕЛЬНО от БД и хранить не рядом с бэкапами SQLite:
владелец файла подписывает JWT за любого пользователя. `scripts/backup_server_dbs.sh`
ставит `umask 077` и при `PARVANE_BACKUP_AGE_RECIPIENT=age1…` шифрует снимки
`age` (открытая копия удаляется).

## Восстановление из бэкапа
```bash
D=2026-09-01                                # нужная дата
docker compose stop identity messenger cloud call preview push
for s in identity messenger cloud call preview push; do
  docker run --rm -v parvane_db:/data -v ~/parvane/backups:/bak alpine \
    sh -c "cp /bak/$s-$D.sqlite /data/$s.db && rm -f /data/$s.db-wal /data/$s.db-shm"
done
docker compose start identity messenger cloud call preview push
```
(Восстанавливай ВСЕ шарды одной датой — они связаны: сообщения ссылаются на
аккаунты/файлы.)

## Пользователи (в закрытом режиме их и так гейтит пароль сайта)
Посмотреть:
```bash
docker run --rm -v parvane_db:/data alpine sh -c \
  'apk add -q sqlite; sqlite3 /data/identity.db "select username,display_name from users"'
```
Удалить аккаунт (бан):
```bash
docker run --rm -v parvane_db:/data alpine sh -c \
  'apk add -q sqlite; sqlite3 /data/identity.db "delete from users where username=\"кого@local\""'
```
Вычистить ВСЁ начисто (новый пузырь): `backup.sh`, затем
`docker compose stop <шарды>` → удалить `/data/*.db` в томе `parvane_db` →
`docker compose start <шарды>` (пересоздадут пустые).

## Диск / рост
Медиа копится в `cloud.db` (том `parvane_db`). Смотреть:
```bash
docker run --rm -v parvane_db:/data alpine sh -c 'ls -lh /data/*.db'
df -h /                                     # свободно на хосте
```

## Обновление кода (с рабочей машины, НЕ на сервере)
`backend/infra/deploy/deploy.sh` — пересобирает образы (podman, baseline x86-64) и dist,
заливает, поднимает. Флаги: `PARVANE_DEPLOY_SKIP_WEB_BUILD=1`,
`PARVANE_DEPLOY_SKIP_IMAGES=1`. После заливки dist Caddy перезапускается
автоматически (иначе bind-mount отдаёт 404).

## TURN на VPS (звонки с мобильных сетей)
Relay хостера (192.168.0.20, «кривой» range-DNAT) снаружи недостижим: звонок с
телефона (CGNAT/VPN) висел на «exchanging encryption keys» и падал. TURN/STUN
поднят на VPS 213.155.15.139 (публичный IP, тот же хост, что Telegram-бот):
- бинарь `/usr/local/bin/parvane-turn` (backend/infra/turn, сборка:
  `podman run --rm --network=host -v $PWD:/src:Z -w /src -e CGO_ENABLED=0
  golang:1-alpine go build -o parvane-turn .`), systemd `parvane-turn`,
  env `/etc/parvane/turn.env` (TURN_SECRET = PARVANE_TURN_SECRET прода,
  UDP+TCP 3478, relay 49160-49400, TURN_PUBLIC_IP=213.155.15.139).
- прод `.env`: `PARVANE_TURN_URL=turn:213.155.15.139:3478?transport=udp,
  turn:213.155.15.139:3478?transport=tcp`, `PARVANE_STUN_URLS=stun:213.155.15.139:3478`
  (call-шард принимает список URL через запятую; compose подставляет старый
  локальный TURN, если переменные не заданы).
- локальный контейнер `turn` из compose и его сборка из deploy.sh удалены
  (6 сен 2026); PARVANE_TURN_RELAY_IP/MIN/MAX_PORT в .env прода больше не
  используются.
- проверка снаружи: `TURN_URL=turn:213.155.15.139:3478?transport=udp
  TURN_USER=<expiry>:probe@local TURN_PASS=<base64 HMAC-SHA1(secret, user)>
  node scripts/e2e_turn_relay_check.mjs` → `RELAY OK` с relay-кандидатом
  213.155.15.139. Логи: `journalctl -u parvane-turn -f` на VPS.

## Проброс хостера: замер 14 сен 2026 (после «исправления» админом)
Админ убрал случайность range-DNAT, но не более того. Измерено снаружи
(слушатели на сервере / VPS 213.155.15.139 как внешний наблюдатель):
- **Внутрь**: внешний `20160+k` → внутренний `49160+k` стабильно по всему
  диапазону (раньше — случайный порт). «Те же порты» (20160→20160) НЕ сделаны.
- **Наружу**: ОТВЕТ на входящий поток NAT переписывает верно (VPS → 20170 →
  49170, ответ с 49170 виден на VPS как `185.81.248.52:20170`, conntrack).
  Но поток, который сервер НАЧИНАЕТ сам с `49170`, уходит как
  `185.81.248.52:49170` (статичного SNAT на диапазон нет), а внешний `49170`
  внутрь не проброшен — ответ на такой пакет теряется. Для ICE это значит:
  проверка со стороны relay, ушедшая РАНЬШЕ первого пакета собеседника,
  пропадает (гонка). У одиночных пробросов (20443, 20080, 20478) всё честно.
- **TCP на 9223** (просьба от 1 сен): не проброшен — полный скан 1–65535 при
  живом слушателе на 9223, ни одного соединения; ufw на сервере выключен.
- Следствие для TURN на проде (временно поднимался как процесс, без деплоя):
  аллокация работает по UDP и TCP, relay-кандидат отдаётся с внешним портом
  (патч `TURN_RELAY_PORT_OFFSET=-29000` в `infra/turn/main.go`: биндим 49160+k,
  клиенту сообщаем 20160+k). Но данные через relay с внешним пиром
  (`ASYM=1`): по TCP-транспорту 5 из 5, по UDP-транспорту 1 из 6 — ненадёжно
  (см. п. выше про гонку; точный механизм UDP-провалов до конца не
  локализован). Relay↔relay на одном сервере не работает вовсе: NAT не делает
  hairpin (пакет сервера на свой публичный IP теряется).
- **Что просить у админа**: внутрь на ТЕ ЖЕ порты 20160–20200 на
  192.168.0.20 (тогда пакет с 20170 и сам по себе уходит с 20170 — статичный
  SNAT не нужен, гонка исчезает; сдвиг в TURN отключить: MIN/MAX=20160/20200,
  OFFSET=0); плюс любой внешний TCP-порт → 192.168.0.20:9223. Hairpin остаётся —
  relay↔relay через один прод-TURN не заработает и после этого (VPS-TURN
  как второй сервер закрывает этот случай).
  Пока этого нет — TURN остаётся на VPS, ничего на проде не менялось.
- Инструменты: `scripts/e2e_turn_relay_check.mjs` (аллокация),
  `scripts/e2e_turn_relay_loopback.mjs` (реальный обмен данными через relay;
  `ASYM=1` — второй пир без TURN, только STUN — основной сценарий; без него —
  relay↔relay, требует hairpin). `infra/turn/verify_turn.sh` починен: сервер
  без `TURN_USER` не принимает статичные креды turntest (было «Allocate error 400»).

## Лимиты частоты gateway (клиент недоверенный)
На авторизованную сессию три token-bucket (всплеск / устойчиво в секунду),
переопределяются env gateway в compose: сообщения `msg.chat.*`
`GATEWAY_RATE_MSG_BURST=30` / `GATEWAY_RATE_MSG_PER_SEC=3`; чанки загрузки
`file.upload.*` `GATEWAY_RATE_UPLOAD_BURST=400` / `GATEWAY_RATE_UPLOAD_PER_SEC=40`
(≈10 МБ/с); прочие request `GATEWAY_RATE_REQ_BURST=120` / `GATEWAY_RATE_REQ_PER_SEC=20`.
Превышение — err-фрейм `rate_limited…` (клиент показывает «Слишком много
действий»), в логах gateway `rate limit: <user> pub/req <subject>`.
Проверка: `scripts/run_gateway_rate_limit_e2e.sh`.

Протокол v2, анонимный канал (spec 007, T123, D-08/D-17): анонимные соединения
одноразовые, поэтому лимит считается на IP-источник (ключ — SipHash адреса с
ключом процесса, IPv6 — по /64; только память gateway, IP не журналируется и
не уходит в шину): все ANON-запросы `GATEWAY_RATE_ANON_IP_BURST=600` /
`GATEWAY_RATE_ANON_IP_PER_SEC=60`, бандлы ключей
`identity.device.fetch_bundle_anon` отдельно `GATEWAY_RATE_BUNDLE_IP_BURST=60` /
`GATEWAY_RATE_BUNDLE_IP_PER_SEC=1`. Превышение — `RATE_LIMITED` с
`retry_after_ms`. В identity `PARVANE_V2_BUNDLE_RATE=60` — бандлов одного
адресата в минуту с расходом OTK; сверх него отдаётся только fallback-ключ
(не отказ: чужой флуд не блокирует первый контакт).

Лимиты identity по источнику: gateway подставляет `client_ip` (X-Forwarded-For
за Caddy, иначе адрес пира) в `identity.user.register` и `identity.token.issue`;
identity отказывает после `PARVANE_REGISTER_RATE_IP=30` регистраций или
`PARVANE_LOGIN_RATE_IP=120` логинов в минуту с одного IP (в дополнение к лимитам
по логину). При прямом NATS (dev без gateway) поле пусто — лимит по IP не
применяется.

## Отключение v1 (E6)

Протокол v1 (JSON-кадры gateway) выключается оператором по статистике версий
устройств, в три шага. Режим задаёт переменная gateway `PARVANE_V1_MODE`
(`environment` сервиса `gateway`, читается при старте — после смены
`docker compose up -d gateway`). На v2-соединения режим не влияет ни в одном
значении: Hello → Welcome → Auth работают как раньше.

1. **Смотреть статистику.** Метод оператора `server.stats.versions` (v2,
   идентифицированный канал; аккаунт оператора перечислен в
   `PARVANE_OPERATORS` gateway, остальным — `FORBIDDEN`). Ответ: `versions[]` —
   число неотозванных v2-устройств по `proto_major.proto_minor`, и
   `legacy_devices` — устройства, у которых есть ключи v1, но нет сертификата
   v2. То же напрямую из БД identity (том `parvane_db-identity`):

   ```bash
   docker run --rm -v parvane_db-identity:/data alpine sh -c 'apk add -q sqlite;
     sqlite3 /data/identity.db-v2.db "SELECT proto_major, proto_minor, COUNT(*) FROM device_state WHERE revoked = 0 GROUP BY 1, 2;";
     sqlite3 /data/identity.db "ATTACH \"/data/identity.db-v2.db\" AS v2;
       SELECT COUNT(*) FROM device_keys k WHERE NOT EXISTS
         (SELECT 1 FROM v2.device_state d WHERE d.user = k.username AND d.device_id = k.device_id);"'
   ```

   Переходить к шагу 2, когда `legacy_devices` перестал убывать сам (активные
   клиенты обновились, остались редкие и заброшенные устройства).
2. **`PARVANE_V1_MODE=notice`.** v1 продолжает работать; после каждого входа
   по v1 gateway шлёт кадр `{"op":"notice","kind":"upgrade_available"}`.
   Клиенты показывают нативное уведомление «доступна новая версия» (web —
   уведомление, desktop и android — сообщение в чате служебных уведомлений,
   один раз за запуск). Держать режим, пока `legacy_devices` снижается.
3. **`PARVANE_V1_MODE=disabled`.** Любое v1-соединение на первый же свой кадр
   получает `{"op":"err","error":"upgrade_required"}` и закрывается. Клиенты
   показывают «обновите приложение», учётные данные и ключи не трогают и не
   крутят переподключение (повторная проба — не чаще раза в 5 минут). В логе
   gateway при первом v1-соединении: «v1-путь в режиме Disabled».

**Откат** на любом шаге — вернуть `PARVANE_V1_MODE=normal` (или убрать
переменную) и перезапустить gateway: старые клиенты подключатся при следующей
пробе (до 5 минут) или после перезапуска приложения. Данные v1 при этом не
затрагиваются (`scripts/protocol_rollback_check.sh`).

Не путать с `PARVANE_V2_MIN_MINOR` — это нижняя граница минорной версии v2
(`UPGRADE_REQUIRED` для старых v2-клиентов), к v1 она не относится.

**Удаление кода v1** (v1-обработчики шардов, JSON-путь gateway, libolm в web,
`e2e.cpp` в parvane-core) — отдельное изменение ПОСЛЕ того, как режим
`disabled` простоял без обращений пользователей; этим разделом не покрывается.

Проверка: `cargo test -p parvane-integration --test v1_mode_live` (три gateway
в режимах normal/notice/disabled на одном стеке, v1-кадры и рукопожатие v2),
разбор кадров клиентами — `desktop/parvane-core/tests/gateway_upgrade_tests.cpp`
(ctest `gateway_upgrade`), android `L2PrivacySeamTest` (тесты `upgrade*`).

## Переменные окружения лимитов и защит (после ревью 2026-09-27)
Все — необязательные, значения по умолчанию в скобках; задаются в `environment`
соответствующего сервиса compose.

| Переменная | Шард | Смысл |
|---|---|---|
| `PARVANE_HANDLER_CONCURRENCY` (32) | identity, cloud, preview, push | сколько обработчиков запросов работают параллельно (spawn под семафором, п. 4.5) |
| `PARVANE_PREKEY_FETCH_RATE` (20) / `PARVANE_PREKEY_FETCH_DAILY` (200) | identity | фетчей prekey-бандла на пару запросивший→цель за минуту / за сутки (P-21) |
| `PARVANE_PREKEY_REUSE_SECS` (600) | identity | окно, в котором повторный фетч той же пары отдаёт тот же one-time prekey (P-21) |
| `PARVANE_REGISTER_RATE_IP` (30) / `PARVANE_LOGIN_RATE_IP` (120) | identity | лимиты по IP за минуту (P-43) |
| `PARVANE_CLOUD_MAX_DOWNLOAD_CHUNKS` (256) | cloud | верхняя граница чанков одного download-запроса (P-28) |
| `PARVANE_PREVIEW_RATE` (60) | preview | запросов превью и тайлов на пользователя за минуту (P-30, P-23) |
| `PARVANE_PREVIEW_TILE_CACHE_MAX` (20000) | preview | кап кэша тайлов карты, старые выселяются (P-23) |
| `PARVANE_PUSH_MAX_SUBSCRIPTIONS` (8) | push | web-push подписок на пользователя (P-17) |
| `PARVANE_GROUP_MAX_MEMBERS` (200) | messenger | участников в группе (P-34) |
| `PARVANE_GATEWAY_REVERIFY_SECS` (300) | gateway | период переверификации JWT открытой сессии (P-06) |
| `PARVANE_GATEWAY_MAX_CONNS` / `PARVANE_GATEWAY_MAX_CONNS_PER_IP` | gateway | лимиты соединений (P-37) |
| `PARVANE_GATEWAY_ORIGIN` | web build | origin gateway для `connect-src` в CSP (P-32); по умолчанию `'self'` |
| `PARVANE_DEV=1` | identity | dev-режим: код подтверждения в лог, `identity.server.info` без ограничений — только в тестах |

Ошибки клиенту (п. 4.10): SQLite/IO-ошибки уходят как `internal_error`, ошибки
разбора JSON — `bad_request`; детали только в логах шарда.

## Пользователь потерял ключ восстановления (копия корня у администратора)

Ключ восстановления показывается пользователю один раз; без него нельзя войти на новом устройстве, когда
других не осталось, и сменить ключ подписи устройств. Страховка: клиент кладёт на сервер копию корня,
запечатанную ОТКРЫТЫМ ключом администратора; закрытый ключ хранится у администратора ВНЕ сервера (менеджер
паролей / флешка) — сервер и его бэкапы без него копии не читают.

- **Включить (один раз):** на рабочей машине `cd backend && cargo run -p parvane-protocol --bin escrow_admin --
  keygen ~/parvane-escrow-admin.key` — закрытый ключ ляжет в файл (0600), открытый напечатается. Открытый — в
  `~/parvane/.env` на сервере строкой `PARVANE_ESCROW_PUBLIC_KEY=<открытый>`, затем `docker compose up -d
  identity`. Файл ключа сохранить в двух местах: потеря = копии не открыть никогда; утечка вместе с базой
  identity = чужие корни. Сменить ключ можно, но прежние копии останутся под прежним.
- **Выписать новый ключ:** `scripts/admin_recover_user.sh <ник@домен> ~/parvane-escrow-admin.key` (с рабочей
  машины; ssh из `.deploy.env`). Печатает новый ключ восстановления — передать пользователю лично. Пользователь:
  Настройки → Устройства → «Ввести ключ восстановления». Корень прежний — собеседники предупреждения не видят.
- **У кого копия есть:** у тех, чей клиент создал корень или вводил ключ восстановления ПОСЛЕ включения
  (`select user, datetime(updated_at,'unixepoch') from root_escrow` в `identity.db-v2.db`). У остальных скрипт
  ответит «нет копии» — им остаётся сброс личности (новый корень, собеседники видят смену ключа).
- Администратор, выписывая ключ, технически видит корень пользователя — это и есть цена страховки.

## Сверка ключей безопасности
Профиль собеседника → «Ключ безопасности»: отпечатки identity-ключей его
устройств (SHA-256, 12 групп hex); Settings → Privacy → «Ваш ключ
безопасности». Смена ключа известного контакта даёт локальное служебное
сообщение в чате («Ключ безопасности … изменился»). Сверять голосом или по
другому каналу — защита от подмены ключей на сервере.

## Hardening контейнеров и тома на шард (P-31, P-50)

- Образ `parvane-shards` запускает бинарники под пользователем `parvane`
  (uid 10001), compose даёт `read_only`, `cap_drop: ALL`,
  `no-new-privileges`, `tmpfs /tmp`. Запись — только в том `/data` шарда.
- У каждого шарда **свой** том: `parvane_db-identity`, `parvane_db-messenger`,
  `parvane_db-cloud`, `parvane_db-call`, `parvane_db-preview`, `parvane_db-push`
  (раньше — общий `parvane_db`). RCE в preview больше не читает `identity.db`.
- **Миграция с общего тома** (один раз, при остановленных шардах):

  ```bash
  docker compose stop identity messenger cloud call preview push
  for s in identity messenger cloud call preview push; do
    docker run --rm -v parvane_db:/old -v parvane_db-$s:/data alpine sh -c \
      "cp -a /old/$s.db* /data/ 2>/dev/null; cp -a /old/$s-* /data/ 2>/dev/null; \
       chown -R 10001:10001 /data"
  done
  docker compose up -d
  ```

  Ключи `identity-jwt-ed25519.pem` и `push-vapid-p256.pem` попадают в свои
  тома тем же циклом (`/old/identity-*`, `/old/push-*`). Старый том удалять
  только после проверки: `docker volume rm parvane_db`.
- Команды из разделов выше с `-v parvane_db:/data` теперь выполняются с томом
  конкретного шарда (`-v parvane_db-identity:/data` и т.п.).
- Адрес, порт SSH и логин прод-сервера в `deploy.sh` больше не зашиты:
  задайте `PARVANE_DEPLOY_SSH_DEST`, `PARVANE_DEPLOY_SSH_PORT`,
  `PARVANE_DEPLOY_PUBLIC_HOST` (файл `backend/infra/deploy/.deploy.env`,
  в `.gitignore`). В контейнер NATS уходят только его пароли, а не весь `.env`.
- TURN (P-16): relay на loopback/приватные/link-local/multicast адреса
  запрещён (`PermissionHandler` в `parvane-turn`, `denied-peer-ip` в
  `coturn.conf`); статический пользователь TURN не заводится — только
  краткоживущие креды по `PARVANE_TURN_SECRET`.
