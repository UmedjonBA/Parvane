#!/usr/bin/env bash
# Деплой Parvane на m60-7. Запускать ЛОКАЛЬНО (нужны podman, npm, ssh-доступ
# по ключу). Сборка образов — локально под baseline x86-64, на сервер уезжают
# готовые образы (docker load) + конфиги + web-dist.
#
#   PARVANE_DEPLOY_SKIP_WEB_BUILD=1  — не пересобирать web dist
#   PARVANE_DEPLOY_SKIP_IMAGES=1     — не пересобирать/не перезаливать образы

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_PORT=2240
SSH_DEST=umejon@185.81.248.52
SSH=(ssh -p "$SSH_PORT" -o BatchMode=yes "$SSH_DEST")
REMOTE_DIR=parvane

log() { printf '\n== %s ==\n' "$*"; }

if [[ "${PARVANE_DEPLOY_SKIP_WEB_BUILD:-0}" != "1" ]]; then
  log "Web dist (npm run build:production)"
  (cd "$ROOT/web/telegram-tt" && npm run build:production)
fi

if [[ "${PARVANE_DEPLOY_SKIP_IMAGES:-0}" != "1" ]]; then
  # --http-proxy=false: не передавать в сборку прокси-переменные хоста
  # (локальный sing-box из контейнера недостижим/медленный, прямой доступ есть)
  log "Сборка образа шардов (podman, baseline x86-64)"
  podman build --http-proxy=false -f "$ROOT/infra/deploy/Dockerfile.shards" \
    --ignorefile "$ROOT/infra/deploy/shards.dockerignore" \
    -t parvane-shards "$ROOT"

  log "Заливка образов на сервер (docker load)"
  podman save --format docker-archive parvane-shards | gzip -1 | "${SSH[@]}" 'gunzip | docker load'
fi

log "Заливка конфигов и web-dist (tar over ssh — rsync локально нет)"
"${SSH[@]}" "mkdir -p $REMOTE_DIR/nats"
scp -P "$SSH_PORT" -q "$ROOT/infra/deploy/docker-compose.yml" \
  "$ROOT/infra/deploy/Caddyfile" "$SSH_DEST:$REMOTE_DIR/"
scp -P "$SSH_PORT" -q "$ROOT/infra/nats/server.prod.conf" "$SSH_DEST:$REMOTE_DIR/nats/"
tar -C "$ROOT/web/telegram-tt/dist" -czf - . \
  | "${SSH[@]}" "rm -rf $REMOTE_DIR/web-dist.new && mkdir -p $REMOTE_DIR/web-dist.new \
      && tar -C $REMOTE_DIR/web-dist.new -xzf - \
      && rm -rf $REMOTE_DIR/web-dist && mv $REMOTE_DIR/web-dist.new $REMOTE_DIR/web-dist"
# Подмена каталога web-dist меняет inode — bind-mount у работающего caddy
# продолжает смотреть в удалённый каталог (всё отдаётся 404). Перемонтируем.
"${SSH[@]}" "cd $REMOTE_DIR && docker compose restart caddy >/dev/null 2>&1 || true"

log "Секреты (.env генерируется один раз) и запуск"
"${SSH[@]}" bash -s <<'REMOTE'
set -Eeuo pipefail
cd parvane
if [[ ! -f .env ]]; then
  gen() { openssl rand -hex 24; }
  relay_ip="$(hostname -I | awk '{print $1}')"
  cat > .env <<EOF
PARVANE_PUBLIC_HOST=185.81.248.52
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
PARVANE_GATEWAY_PASS=$(gen)
PARVANE_TURN_SECRET=$(gen)
PARVANE_TURN_STATIC_PASS=$(gen)
EOF
  chmod 600 .env
  echo ".env создан"
fi
# NATS перечитывает ACL только по сигналу: без этого шарды, стартующие с новыми
# топиками, ловят Subscription Violation (подписка молча отброшена) — HUP ДО up
docker kill -s HUP parvane-nats-1 >/dev/null 2>&1 || true
sleep 1
docker compose up -d --remove-orphans
docker compose ps
REMOTE

log "Готово: https://185.81.248.52:20443"
