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

## Пароль сайта (basic-auth приватного круга)
Сменить пароль:
```bash
NEW='новыйпароль'
H=$(docker compose exec -T caddy caddy hash-password --plaintext "$NEW")
# ВАЖНО: удвоить каждый $ в хэше, иначе docker compose его испортит
HESC=$(printf '%s' "$H" | sed 's/[$]/$$/g')
sed -i '/^PARVANE_SITE_HASH=/d' .env
printf 'PARVANE_SITE_HASH=%s\n' "$HESC" >> .env
docker compose up -d caddy
# проверка:
curl -sk -o /dev/null -w '%{http_code}\n' -u "parvane:$NEW" https://parvane.duckdns.org:20443/   # 200
curl -sk -o /dev/null -w '%{http_code}\n' https://parvane.duckdns.org:20443/                       # 401
```
Открыть регистрацию всем (снять пароль): убрать блок `basic_auth {…}` из
`Caddyfile` → `docker compose restart caddy`.

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
