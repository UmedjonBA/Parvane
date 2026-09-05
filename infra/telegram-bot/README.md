# Telegram-бот подтверждения регистрации

Подтверждение аккаунта без SMTP: клиент показывает deep link
`t.me/<bot>?start=<token>`, пользователь жмёт Start, бот вызывает
`identity.telegram.confirm` через публичный WSS gateway с общим секретом,
identity привязывает Telegram-аккаунт (один Telegram = один аккаунт) и
подтверждает ник; веб-клиент опрашивает `identity.register.status` и
логинится сам.

Бот живёт отдельно от прод-сервера, потому что с него `api.telegram.org`
недоступен. Сейчас — VPS 213.155.15.139 (Ubuntu 24.04, там же sing-box Ruh
VPN — не трогать).

## Установка на VPS (root)

```bash
apt-get install -y python3-websockets
useradd -r -s /usr/sbin/nologin parvane-bot || true
mkdir -p /opt/parvane-tg-bot /etc/parvane
cp parvane_tg_bot.py /opt/parvane-tg-bot/
cp parvane-tg-bot.service /etc/systemd/system/
cp tg-bot.env.example /etc/parvane/tg-bot.env && chmod 600 /etc/parvane/tg-bot.env
# заполнить /etc/parvane/tg-bot.env: токен бота, секрет, URL gateway
systemctl daemon-reload && systemctl enable --now parvane-tg-bot
journalctl -u parvane-tg-bot -f
```

## Настройка identity (прод, .env)

```
PARVANE_TELEGRAM_BOT=Parvane_test_bot      # username бота без @
PARVANE_TELEGRAM_SECRET=<openssl rand -hex 32>   # тот же, что у бота
```
Режим Telegram имеет приоритет над `PARVANE_EMAIL_REQUIRED`. Убрать обе
переменные — регистрация без подтверждения.

## Локальная проверка

`scripts/run_web_telegram_e2e.sh` поднимает стек с
`PARVANE_TELEGRAM_BOT/SECRET` и играет роль бота сам (шлёт
`identity.telegram.confirm` в gateway из node).
