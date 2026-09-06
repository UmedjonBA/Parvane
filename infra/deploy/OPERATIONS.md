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
(`infra/telegram-bot`, юнит `parvane-tg-bot`, env `/etc/parvane/tg-bot.env`),
потому что с прод-сервера api.telegram.org недоступен. В `.env` identity:
```
PARVANE_TELEGRAM_BOT=Parvane_test_bot
PARVANE_TELEGRAM_SECRET=<тот же, что у бота>
```
Проверка: `journalctl -u parvane-tg-bot -f` на VPS, `docker compose logs
identity | grep Telegram` на проде.

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
- Вручную: `~/parvane/backup.sh`
- Проверить снимок: `docker run --rm -v ~/parvane/backups:/bak alpine sh -c 'apk add -q sqlite; sqlite3 /bak/messenger-<дата>.sqlite "PRAGMA integrity_check"'`

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
`infra/deploy/deploy.sh` — пересобирает образы (podman, baseline x86-64) и dist,
заливает, поднимает. Флаги: `PARVANE_DEPLOY_SKIP_WEB_BUILD=1`,
`PARVANE_DEPLOY_SKIP_IMAGES=1`. После заливки dist Caddy перезапускается
автоматически (иначе bind-mount отдаёт 404).

## TURN на VPS (звонки с мобильных сетей)
Relay хостера (192.168.0.20, «кривой» range-DNAT) снаружи недостижим: звонок с
телефона (CGNAT/VPN) висел на «exchanging encryption keys» и падал. TURN/STUN
поднят на VPS 213.155.15.139 (публичный IP, тот же хост, что Telegram-бот):
- бинарь `/usr/local/bin/parvane-turn` (infra/turn, сборка:
  `podman run --rm --network=host -v $PWD:/src:Z -w /src -e CGO_ENABLED=0
  golang:1-alpine go build -o parvane-turn .`), systemd `parvane-turn`,
  env `/etc/parvane/turn.env` (TURN_SECRET = PARVANE_TURN_SECRET прода,
  UDP+TCP 3478, relay 49160-49400, TURN_PUBLIC_IP=213.155.15.139).
- прод `.env`: `PARVANE_TURN_URL=turn:213.155.15.139:3478?transport=udp,
  turn:213.155.15.139:3478?transport=tcp`, `PARVANE_STUN_URLS=stun:213.155.15.139:3478`
  (call-шард принимает список URL через запятую; compose подставляет старый
  локальный TURN, если переменные не заданы).
- проверка снаружи: `TURN_URL=turn:213.155.15.139:3478?transport=udp
  TURN_USER=<expiry>:probe@local TURN_PASS=<base64 HMAC-SHA1(secret, user)>
  node scripts/e2e_turn_relay_check.mjs` → `RELAY OK` с relay-кандидатом
  213.155.15.139. Логи: `journalctl -u parvane-turn -f` на VPS.
