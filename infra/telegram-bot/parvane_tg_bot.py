#!/usr/bin/env python3
"""Telegram-бот подтверждения регистрации Parvane.

Клиент показывает deep link t.me/<bot>?start=<token>; пользователь жмёт Start,
бот получает `/start <token>` и через WSS gateway (как обычный pre-auth клиент)
вызывает identity.telegram.confirm с общим секретом. identity привязывает
Telegram-аккаунт к pending-нику и подтверждает его; веб-клиент, опрашивающий
identity.register.status, логинится сам.

Живёт на хосте с доступом к api.telegram.org (с прод-сервера Parvane Telegram
недоступен). Зависимости: python3 + websockets (apt: python3-websockets).

Переменные окружения (см. parvane-tg-bot.env.example):
  PARVANE_TG_BOT_TOKEN      токен бота от @BotFather
  PARVANE_TELEGRAM_SECRET   общий секрет с identity (PARVANE_TELEGRAM_SECRET)
  PARVANE_GATEWAY_URL       wss://<host>:<port>/ws прод-сервера Parvane
  PARVANE_TG_APP_NAME       название для текстов (по умолчанию Parvane)
"""

import asyncio
import json
import logging
import os
import sys
import urllib.parse
import urllib.request

import websockets

log = logging.getLogger("parvane-tg-bot")

BOT_TOKEN = os.environ.get("PARVANE_TG_BOT_TOKEN", "").strip()
SECRET = os.environ.get("PARVANE_TELEGRAM_SECRET", "").strip()
GATEWAY_URL = os.environ.get("PARVANE_GATEWAY_URL", "").strip()
APP_NAME = os.environ.get("PARVANE_TG_APP_NAME", "Parvane").strip() or "Parvane"

API = f"https://api.telegram.org/bot{BOT_TOKEN}"
POLL_TIMEOUT_S = 50
GATEWAY_TIMEOUT_S = 15

TEXT_HELP = (
    f"Это бот подтверждения регистрации в {APP_NAME}.\n\n"
    f"Откройте {APP_NAME}, нажмите «Create account», заполните ник и пароль — "
    "и на следующем экране нажмите «Open Telegram». Тогда я подтвержу аккаунт."
)
TEXT_OK = "Аккаунт {user} подтверждён ✅\nВозвращайтесь в " + APP_NAME + " — вход произойдёт сам."
TEXT_OK_LOGIN = "Вход в аккаунт {user} подтверждён. Возвращайтесь в Parvane."
TEXT_FAIL = "Не получилось подтвердить: {error}\nНачните регистрацию в " + APP_NAME + " заново и нажмите Start по новой ссылке."
TEXT_DOWN = "Сервер " + APP_NAME + " сейчас недоступен, попробуйте через минуту."


def tg_call(method: str, **params):
    data = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}).encode()
    request = urllib.request.Request(f"{API}/{method}", data=data)
    with urllib.request.urlopen(request, timeout=POLL_TIMEOUT_S + 10) as response:
        body = json.load(response)
    if not body.get("ok"):
        raise RuntimeError(f"telegram {method}: {body}")
    return body["result"]


async def confirm_via_gateway(token: str, telegram_id: int, telegram_name: str) -> dict:
    payload = json.dumps({
        "secret": SECRET,
        "token": token,
        "telegram_id": telegram_id,
        "telegram_name": telegram_name,
    })
    frame = json.dumps({
        "op": "req", "id": "1", "subject": "identity.telegram.confirm",
        "payload": payload, "timeout_ms": 5000,
    })
    async with websockets.connect(GATEWAY_URL, open_timeout=GATEWAY_TIMEOUT_S) as ws:
        await ws.send(frame)
        while True:
            raw = await asyncio.wait_for(ws.recv(), GATEWAY_TIMEOUT_S)
            reply = json.loads(raw)
            if reply.get("id") != "1":
                continue
            if reply.get("op") == "err":
                return {"ok": False, "error": reply.get("error", "ошибка gateway")}
            if reply.get("op") == "reply":
                return json.loads(reply.get("payload") or "{}")


async def handle_message(message: dict):
    chat_id = message["chat"]["id"]
    sender = message.get("from") or {}
    text = (message.get("text") or "").strip()
    if not text.startswith("/start"):
        tg_call("sendMessage", chat_id=chat_id, text=TEXT_HELP)
        return
    parts = text.split(maxsplit=1)
    token = parts[1].strip() if len(parts) > 1 else ""
    if not token:
        tg_call("sendMessage", chat_id=chat_id, text=TEXT_HELP)
        return
    name = sender.get("username") or " ".join(
        filter(None, [sender.get("first_name"), sender.get("last_name")])
    )
    try:
        result = await confirm_via_gateway(token, int(sender["id"]), name)
    except Exception as error:  # noqa: BLE001 — любая сетевая ошибка = «сервер недоступен»
        log.error("gateway недоступен: %s", error)
        tg_call("sendMessage", chat_id=chat_id, text=TEXT_DOWN)
        return
    if result.get("ok"):
        user = result.get("user") or ""
        nick = user.split("@")[0] if user else "?"
        kind = result.get("kind") or "register"
        log.info("подтверждён %s (%s) для tg %s (%s)", user, kind, sender.get("id"), name)
        text = TEXT_OK_LOGIN if kind == "login" else TEXT_OK
        tg_call("sendMessage", chat_id=chat_id, text=text.format(user=f"@{nick}"))
    else:
        log.warning("отказ для tg %s: %s", sender.get("id"), result.get("error"))
        tg_call("sendMessage", chat_id=chat_id, text=TEXT_FAIL.format(error=result.get("error", "неизвестная ошибка")))


async def main():
    if not (BOT_TOKEN and SECRET and GATEWAY_URL):
        log.error("нужны PARVANE_TG_BOT_TOKEN, PARVANE_TELEGRAM_SECRET, PARVANE_GATEWAY_URL")
        sys.exit(2)
    me = tg_call("getMe")
    log.info("бот @%s запущен, gateway %s", me.get("username"), GATEWAY_URL)
    offset = None
    loop = asyncio.get_running_loop()
    while True:
        try:
            updates = await loop.run_in_executor(
                None, lambda: tg_call("getUpdates", offset=offset, timeout=POLL_TIMEOUT_S, allowed_updates='["message"]'),
            )
        except Exception as error:  # noqa: BLE001
            log.error("getUpdates: %s", error)
            await asyncio.sleep(5)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            message = update.get("message")
            if message and message.get("chat", {}).get("type") == "private":
                try:
                    await handle_message(message)
                except Exception as error:  # noqa: BLE001
                    log.error("обработка сообщения: %s", error)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
