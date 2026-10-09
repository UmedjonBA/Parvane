# Telegram-бот подтверждения регистрации

Подтверждение аккаунта без SMTP: клиент показывает deep link
`t.me/<bot>?start=<token>`, пользователь жмёт Start, бот показывает сообщение
с кнопками **«Подтвердить» / «Отклонить»** и ТОЛЬКО по нажатию «Подтвердить»
(тем же Telegram-пользователем, в течение 5 минут) вызывает метод v2
`identity.account.confirm_telegram` (канал PRE, protobuf-кадры `Hello → Welcome →
Request → Response`, минимальный кодек внутри бота — зависимостей кроме
`websockets` нет; с 7 окт 2026, когда v1 на проде отключён) через публичный
WSS gateway с общим секретом;
identity привязывает Telegram-аккаунт (один Telegram = один аккаунт) и
подтверждает ник; клиент опрашивает `identity.register.status` и логинится сам.

Явное подтверждение обязательно: раньше бот подтверждал сразу по Start, и
атакующий, знающий пароль, мог прислать жертве ссылку — одно её нажатие
выдавало второй фактор и `trust_secret` на его устройство (находка P-15).
«Отклонить» — сигнал сменить пароль. Gateway подмешивает IP бота в запрос,
identity ограничивает частоту `identity.telegram.confirm` по IP
(`PARVANE_TG_CONFIRM_RATE_IP`, по умолчанию 10/мин).

Этим же ботом подтверждается **двухфакторный вход** (2FA): при включённой у
пользователя 2FA `identity` требует подтверждения входа с нового устройства
через тот же deep link (`kind=login`). Работает и в веб-, и в десктоп-клиенте.

## Ключ восстановления (spec 015, 10 окт 2026)

Тот же бот хранит у владельца ключ восстановления аккаунта и принимает его при
входе с нового устройства:

- раз в несколько секунд бот забирает у сервера сообщения для владельцев
  (`identity.telegram.pull`, сервер держит запрос до 7 с): вид `key` — сообщение
  с ключом восстановления (уходит сразу после создания аккаунта), вид `ask` —
  просьба ответить ключом (вход с нового устройства);
- любой текст владельца, кроме `/start`, бот передаёт серверу
  (`identity.telegram.reply`); сервер сам проверяет ключ копией корня и отвечает
  `ok` / `bad_key` / `no_request` — бот пишет «Ключ принят» или «не подошёл».

Ключ виден боту, серверу и Telegram открытым текстом (осознанное решение: удобство
важнее). В журнал бота ключ не пишется, на диск бот ничего не сохраняет; у сервера
очередь и ответы — только в памяти. Владельцу, заблокировавшему бота, сообщение не
дойдёт: сервер повторяет его 10 минут и снимает.

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

`scripts/run_web_telegram_bot_e2e.sh` запускает ЭТОТ файл против поддельного Bot API
(`PARVANE_TG_API_BASE`): подтверждение кнопкой, ключ в чат, просьба и приём ответа.
Нужен python с `websockets` той же версии, что на VPS:
`python3 -m venv local-workdirs/tg-bot-venv && local-workdirs/tg-bot-venv/bin/pip install websockets==10.4`.
`scripts/run_web_telegram_recovery_e2e.sh` — то же со стороны клиента, роль бота
играет сценарий.

`scripts/run_web_telegram_e2e.sh` поднимает стек с
`PARVANE_TELEGRAM_BOT/SECRET` и играет роль бота сам (шлёт
`identity.telegram.confirm` в gateway из node).
