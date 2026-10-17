#!/usr/bin/env bash
# Деплой Parvane на m60-7. Запускать ЛОКАЛЬНО (нужны podman, npm, ssh-доступ
# по ключу). Сборка образов — локально под baseline x86-64, на сервер уезжают
# готовые образы (docker load) + конфиги + web-dist.
#
#   Пути считаются от расположения скрипта, рабочий каталог не важен.
#   PARVANE_DEPLOY_SKIP_WEB_BUILD=1  — не пересобирать web dist
#   PARVANE_DEPLOY_SKIP_IMAGES=1     — не пересобирать/не перезаливать образы

set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"   # корень репозитория
BACKEND="$REPO/backend"                                         # Cargo workspace + infra
# P-50: адрес/порт/логин прод-сервера — НЕ в репозитории. Задаются в
# окружении оператора (например, backend/infra/deploy/.deploy.env, в .gitignore):
#   PARVANE_DEPLOY_SSH_DEST=user@host   PARVANE_DEPLOY_SSH_PORT=22
#   PARVANE_DEPLOY_PUBLIC_HOST=host.example  (внешний хост для .env при первом деплое)
DEPLOY_ENV="$(dirname "${BASH_SOURCE[0]}")/.deploy.env"
[[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV"
: "${PARVANE_DEPLOY_SSH_DEST:?задайте PARVANE_DEPLOY_SSH_DEST=user@host}"
: "${PARVANE_DEPLOY_PUBLIC_HOST:?задайте PARVANE_DEPLOY_PUBLIC_HOST}"
SSH_PORT="${PARVANE_DEPLOY_SSH_PORT:-22}"
SSH_DEST="$PARVANE_DEPLOY_SSH_DEST"
SSH=(ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_DEST")
REMOTE_DIR=parvane

log() { printf '\n== %s ==\n' "$*"; }

if [[ "${PARVANE_DEPLOY_SKIP_WEB_BUILD:-0}" != "1" ]]; then
  log "Web dist (npm run build:production)"
  (cd "$REPO/web/telegram-tt" && npm run build:production)
fi

if [[ "${PARVANE_DEPLOY_SKIP_IMAGES:-0}" != "1" ]]; then
  # --http-proxy=false: не передавать в сборку прокси-переменные хоста
  # (локальный sing-box из контейнера недостижим/медленный, прямой доступ есть)
  log "Сборка образа шардов (podman, baseline x86-64)"
  podman build --http-proxy=false -f "$BACKEND/infra/deploy/Dockerfile.shards" \
    --ignorefile "$BACKEND/infra/deploy/shards.dockerignore" \
    -t parvane-shards "$REPO"

  # Скрытый сервис Tor (spec 025): маленький образ alpine + tor
  log "Сборка образа tor (podman)"
  podman build --http-proxy=false -f "$BACKEND/infra/deploy/Dockerfile.tor" -t parvane-tor "$BACKEND/infra/deploy"

  log "Заливка образов на сервер (docker load)"
  podman save --format docker-archive parvane-shards | gzip -1 | "${SSH[@]}" 'gunzip | docker load'
  podman save --format docker-archive parvane-tor | gzip -1 | "${SSH[@]}" 'gunzip | docker load'
fi

# WEB-07: раннер web-e2e собирает в тот же dist диагностическую сборку (хуки
# window.__parvaneDiagCallApi, loopback в CSP) — её заливать нельзя.
if grep -rqs --include='*.js' '__parvaneDiagCallApi' "$REPO/web/telegram-tt/dist/assets" || grep -qs '127.0.0.1' "$REPO/web/telegram-tt/dist/index.html"; then
  echo "dist — диагностическая сборка (e2e); пересоберите: npm run build:production" >&2
  exit 1
fi

# B3: подсказка «Доступно обновление» у открытых вкладок — по `version.txt` в dist:
# сборка пишет туда свой идентификатор (git-хеш, см. vite.config.ts `APP_BUILD`),
# и он же вшит в бандл. Без файла старые вкладки о новой сборке не узнают.
if [[ ! -s "$REPO/web/telegram-tt/dist/version.txt" ]]; then
  echo "в dist нет version.txt — сборка без идентификатора; пересоберите: npm run build:production" >&2
  exit 1
fi
echo "Сборка web: $(cat "$REPO/web/telegram-tt/dist/version.txt")"

log "Заливка конфигов и web-dist (tar over ssh — rsync локально нет)"
"${SSH[@]}" "mkdir -p $REMOTE_DIR/nats"
scp -P "$SSH_PORT" -q "$BACKEND/infra/deploy/docker-compose.yml" \
  "$BACKEND/infra/deploy/Caddyfile" "$SSH_DEST:$REMOTE_DIR/"
scp -P "$SSH_PORT" -q "$BACKEND/infra/nats/server.prod.conf" "$SSH_DEST:$REMOTE_DIR/nats/"
# OPS-05: source maps и build-stats.json апстрима наружу не отдаём.
# B3: хешированные ассеты ПРЕДЫДУЩЕЙ сборки переезжают в новый dist — открытые
# вкладки старой сборки ещё догружают свои ленивые куски (настройки, звонки,
# «План»). Ровно одно поколение: список собственных файлов каждой сборки лежит
# в $REMOTE_DIR/web-dist.assets (вне раздаваемого каталога), переносятся только
# файлы из него, а не всё содержимое assets/ (иначе каталог рос бы бесконечно).
tar -C "$REPO/web/telegram-tt/dist" --exclude='*.map' --exclude='build-stats.json' -czf - . \
  | "${SSH[@]}" "set -e; cd $REMOTE_DIR \
      && rm -rf web-dist.new && mkdir -p web-dist.new \
      && tar -C web-dist.new -xzf - \
      && ls web-dist.new/assets > web-dist.assets.new \
      && if [ -d web-dist/assets ]; then \
           { [ -f web-dist.assets ] && cat web-dist.assets || ls web-dist/assets; } \
             | while read -r f; do \
                 [ -f \"web-dist/assets/\$f\" ] && [ ! -e \"web-dist.new/assets/\$f\" ] \
                   && cp -p \"web-dist/assets/\$f\" web-dist.new/assets/ || true; \
               done; \
         fi \
      && rm -rf web-dist && mv web-dist.new web-dist && mv web-dist.assets.new web-dist.assets"
# Подмена каталога web-dist меняет inode — bind-mount у работающего caddy
# продолжает смотреть в удалённый каталог (всё отдаётся 404). Перемонтируем.
"${SSH[@]}" "cd $REMOTE_DIR && docker compose restart caddy >/dev/null 2>&1 || true"

log "Секреты (.env генерируется один раз) и запуск"
"${SSH[@]}" PARVANE_DEPLOY_PUBLIC_HOST="$PARVANE_DEPLOY_PUBLIC_HOST" bash -s <<'REMOTE'
set -Eeuo pipefail
cd parvane
if [[ ! -f .env ]]; then
  gen() { openssl rand -hex 24; }
  relay_ip="$(hostname -I | awk '{print $1}')"
  umask 077
  cat > .env <<EOF
PARVANE_PUBLIC_HOST=$PARVANE_DEPLOY_PUBLIC_HOST
PARVANE_PUBLIC_HTTPS_PORT=20443
PARVANE_TURN_PUBLIC_PORT=20478
PARVANE_TURN_RELAY_IP=$relay_ip
PARVANE_TURN_MIN_PORT=49160
PARVANE_TURN_MAX_PORT=49200
PARVANE_IDENTITY_PASS=$(gen)
PARVANE_MESSENGER_PASS=$(gen)
PARVANE_CLOUD_PASS=$(gen)
PARVANE_NOTES_PASS=$(gen)
PARVANE_CALENDAR_PASS=$(gen)
PARVANE_CALL_PASS=$(gen)
PARVANE_PREVIEW_PASS=$(gen)
PARVANE_PUSH_PASS=$(gen)
PARVANE_DOMAINS_PASS=$(gen)
PARVANE_GATEWAY_PASS=$(gen)
PARVANE_TURN_SECRET=$(gen)
PARVANE_TURN_STATIC_PASS=$(gen)
EOF
  chmod 600 .env
  echo ".env создан"
fi
# spec 010: шард domains появился позже первого деплоя — пароль дописывается в существующий .env
if ! grep -q '^PARVANE_DOMAINS_PASS=' .env; then
  printf 'PARVANE_DOMAINS_PASS=%s\n' "$(openssl rand -hex 24)" >> .env
  echo "PARVANE_DOMAINS_PASS добавлен в .env"
fi
# NATS перечитывает ACL только по сигналу: без этого шарды, стартующие с новыми
# топиками, ловят Subscription Violation (подписка молча отброшена) — HUP ДО up
docker kill -s HUP parvane-nats-1 >/dev/null 2>&1 || true
sleep 1
# Onion-Location (spec 025): файл подключает Caddyfile; без него bind-mount создал бы каталог
[[ -f onion-location.caddy ]] || : > onion-location.caddy
# Образа tor ещё нет (деплой только web до первой полной выкладки) — без сервиса tor
if docker image inspect localhost/parvane-tor:latest >/dev/null 2>&1; then
  docker compose up -d --remove-orphans
else
  echo "образа parvane-tor нет — сервис tor не поднимается до полной выкладки"
  docker compose up -d --remove-orphans $(docker compose config --services | grep -vx tor)
fi
# Адрес .onion появляется после первого запуска tor (ключ — в томе tor-data); заголовок Onion-Location
# ставится, когда адрес известен
if docker compose ps --services --status running | grep -qx tor; then
  for _ in $(seq 1 60); do
    host="$(docker compose exec -T tor cat /var/lib/tor/hs/hostname 2>/dev/null || true)"
    [[ "$host" =~ ^[a-z2-7]{56}\.onion$ ]] && break
    sleep 2
  done
  if [[ "$host" =~ ^[a-z2-7]{56}\.onion$ ]]; then
    want="header Onion-Location \"http://$host{uri}\""
    if [[ "$(cat onion-location.caddy)" != "$want" ]]; then
      printf '%s\n' "$want" > onion-location.caddy
      docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null
    fi
    echo "Скрытый сервис Tor: http://$host"
  else
    echo "адрес .onion не появился за 2 минуты — смотреть docker compose logs tor" >&2
  fi
fi
docker compose ps
REMOTE

log "Готово: https://$PARVANE_DEPLOY_PUBLIC_HOST:${PARVANE_DEPLOY_PUBLIC_HTTPS_PORT:-20443}"
