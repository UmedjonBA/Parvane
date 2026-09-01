# Деплой Parvane на m60-7

Железный сервер за NAT хостера (общий шлюз `185.81.248.52`), sudo НЕТ, есть
docker+compose. Вход: `ssh -p 2240 umejon@185.81.248.52`. Все файлы живут в
`~/parvane/` на сервере.

## Проброс портов (NAT хостера, проверен 2026-09-01)

| Внешний | Внутренний | Что |
|---|---|---|
| 20443 TCP | 443 | Caddy: web-статика + WSS gateway (`/ws`) |
| 20080 TCP | 80 | редирект на https |
| 20478 TCP+UDP | 3478 | TURN/STUN |
| 20160–20200 UDP | 49160–49200 | TURN-релей. **НЕ 1:1** — range-DNAT со случайным портом; заявка хостеру на «порт-в-порт» отправлена |

Пока relay-проброс кривой, TURN объявляет ПРИВАТНЫЙ IP хоста → работает
double-relay через 3478 (оба пира через наш TURN). Когда хостер починит:
в `.env` сменить `PARVANE_TURN_RELAY_IP` на внешний IP и
`PARVANE_TURN_MIN/MAX_PORT` на новый диапазон.

## TLS

Домена нет → Caddy `tls internal` (self-signed, браузер предупредит один раз).
Let's Encrypt HTTP-01 невозможен (внешний порт не 80); при появлении
DuckDNS-домена перейти на DNS-01 (нужен кастомный образ caddy с плагином).
Без валидного серта не работают service worker/web-push — остальное работает.

## Деплой

```bash
infra/deploy/deploy.sh                 # всё: web dist + образы + заливка + up
PARVANE_DEPLOY_SKIP_WEB_BUILD=1 infra/deploy/deploy.sh   # без пересборки веба
PARVANE_DEPLOY_SKIP_IMAGES=1 infra/deploy/deploy.sh      # только конфиги/статика
```

Образы собираются ЛОКАЛЬНО podman'ом под **baseline x86-64** (Xeon 5160 без
SSE4.2/AVX — target-cpu=native даст SIGILL) и уезжают через `docker load`.
На сервере НЕ собирать (2006-й CPU, 8 ГБ RAM).

`.env` с паролями NATS/TURN генерируется на сервере при первом деплое и НЕ
перезаписывается. Vite dist ~225 МБ, uplink медленный — терпеть.

## Проверка после деплоя

- `https://185.81.248.52:20443` — веб-клиент (принять self-signed серт).
- Smoke против прода:
  ```bash
  PARVANE_E2E_BASE_URL=https://185.81.248.52:20443 \
  PARVANE_E2E_GATEWAY_URL=wss://185.81.248.52:20443/ws \
  node scripts/e2e_web_prod_smoke.mjs
  ```
- Логи: `ssh ... 'cd parvane && docker compose logs --tail 50 identity gateway caddy'`.

## Найдено при первом деплое (2026-09-01)

- **ИСПРАВЛЕНО**: пин/прочтение/реакции ОТРЕДАКТИРОВАННОГО sealed-сообщения не
  доезжали до собеседника — delta-строка после правки обходила decCache
  (`stored.edited`), повторный Olm-decrypt уже потреблённого ct падал, строка
  молча пропускалась. Фикс: `ctHash` (FNV-1a полного ct) в decCache,
  кэш валиден пока ct не сменился (sync.ts/e2e.ts, паритет с desktop).
- **НЕ исправлено (мелкое)**: закреплённые сообщения не восстанавливаются на
  свежей сессии/перелогине — начальный полный sync не применяет флаг pinned
  (updatePinnedIds шлётся только при СМЕНЕ флага в delta; sync.ts:469).
- Пин доезжает до собеседника только периодическим delta-sync (10 с) — live-push
  события пина нет (messenger handle_pin не публикует в инбокс).
- Часы m60-7 спешат на ~80 с (NTP не настроен, sudo нет) — на курсоры не влияет
  (все значения серверные), но помнить при чтении логов.
- id сообщений — uuid v4 (crypto.randomUUID), НЕ v7: строковый курсор
  `last_seen_id` не упорядочен по времени — источник известного «sync-флака».

## Аудит безопасности деплоя (2026-09-01)

Код хорошо укреплён (gateway привязывает actor+token к сессии, plaintext
msg.chat.send запрещён, SSRF-fetcher fail-closed с IP-пиннингом, argon2id,
NATS и порты шардов НЕ опубликованы наружу, .env chmod 600). Замечания по
ПОСТУРЕ развёртывания:

1. **Открытая регистрация** (нет `PARVANE_INVITE_REQUIRED`/`PARVANE_EMAIL_REQUIRED`)
   — любой из интернета создаёт аккаунт. Для закрытого пузыря включить инвайты
   у identity. СРЕДНЕ→ВЫСОКО (зависит от намерения).
2. **Rate-limit регистрации — по username, не по IP** (identity `rate_ok`):
   спам РАЗНЫМИ логинами не троттлится (флуд БД/прекеев). СРЕДНЕ.
3. **Поиск пользователей без токена** (identity `handle_search`): любая сессия
   перечисляет директорию (username/display/avatar/pubkey, LIKE %q%, 20 шт).
   SQL параметризован (инъекции нет), но это harvesting. СРЕДНЕ (приватность).
4. **Self-signed TLS**: браузер предупреждает, MITM возможен при принятии
   поддельного серта, web-push/SW не работают. Контент защищён E2E. Лечится
   DuckDNS-сертом. СРЕДНЕ до домена.
5. **ИСПРАВЛЕНО**: per-IP лимит соединений за Caddy бесполезен (gateway видит
   один IP контейнера caddy на всех веб-клиентов) — стал бы общим потолком
   64 веб-юзера. Поднял `PARVANE_GATEWAY_MAX_CONNS_PER_IP=2000` в compose.
   Реальную per-IP защиту, если нужно, ставить rate-limit'ом в Caddy.
6. **Статичный long-term TURN-кред** (`TURN_USER=parvane`) рядом с ephemeral:
   при утечке пароля — воровство relay-трафика. Можно отключить статик-юзера,
   оставить только ephemeral REST. НИЗКО-СРЕДНЕ.
7. Часы сервера спешат ~80с (нет NTP/sudo) — JWT (24ч) и TURN-кред живут
   на ~80с дольше номинала. НИЗКО.

## Функциональное тестирование против прода (2026-09-01) — ЗЕЛЁНОЕ

Прогнаны реальные браузерные e2e ПРОТИВ https://185.81.248.52:20443
(scripts/run_prod_scenario.sh <сценарий> — добавляет --ignore-certificate-errors,
берёт URL из env). PASS: smoke (текст/правка/реакция/пин/удаление/фото/превью/
группа/reload), voice, media_kinds, content_features (стикеры/GIF/эмодзи/
геолокация/расписание/папки/блок), polls, groups, invites, group_admin, calls
(SAS/mute/видео/decline/история), multidevice, linking, keys_backup, media_ttl,
sync_reconnect, пин/архив чата (пробник). TURN relay — RELAY OK через Chromium.

**Найден баг (не блокер, средне): недетерминированный порядок sync**. id
сообщений — uuid **v4** (случайные), а курсор `last_seen_id` — строковый:
при всплеске сообщений/копий курсор может «перепрыгнуть» через сообщение с
лексикографически меньшим id, и sync его больше не отдаёт (доставлено+acked по
проводу, но выпадает из ленты устройства). Проявилось в devices-сценарии
(1-1 сообщение живому устройству после отзыва сиблинга) и как редкий флак
реакций в sync_reconnect. ЛЕЧИТЬ: uuid v7 для message id (монотонный) ИЛИ
курсор по (updated_at,id), а не по одному id.

## Заметки

- Регистрация ОТКРЫТА (PARVANE_EMAIL_REQUIRED/PARVANE_INVITE_REQUIRED не
  включены) — для закрытого пузыря включить в compose у identity.
- notes/calendar шарды не разворачиваются (к UI не подключены).
- Desktop-клиенту нужен TCP-гейтвей — наружу не проброшен (только WS через
  Caddy); desktop против этого сервера пока не работает.
- Бэкапы SQLite: том `parvane_db` (`docker compose exec`+`sqlite3 .backup`
  или скрипт `scripts/backup_server_dbs.sh` изнутри тома) — TODO cron.
