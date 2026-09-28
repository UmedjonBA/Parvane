#!/usr/bin/env python3
"""Telegram-бот подтверждения регистрации и входа Parvane.

Клиент показывает deep link t.me/<bot>?start=<token>; пользователь жмёт Start,
бот получает `/start <token>` и показывает ЯВНЫЙ запрос подтверждения с кнопками
«Подтвердить» / «Отклонить». Только по нажатию «Подтвердить» (callback_query)
бот через WSS gateway (как обычный pre-auth клиент) вызывает
identity.telegram.confirm с общим секретом; identity привязывает Telegram-аккаунт
к pending-нику или подтверждает вход. Раньше подтверждение шло сразу по Start —
атакующий, знающий пароль, мог прислать жертве ссылку и получить второй фактор
одним её нажатием (находка P-15).

Живёт на хосте с доступом к api.telegram.org (с прод-сервера Parvane Telegram
недоступен). Зависимости: python3 + websockets (apt: python3-websockets).

Переменные окружения (см. tg-bot.env.example):
  PARVANE_TG_BOT_TOKEN      токен бота от @BotFather
  PARVANE_TELEGRAM_SECRET   общий секрет с identity (PARVANE_TELEGRAM_SECRET)
  PARVANE_GATEWAY_URL       wss://<host>:<port>/ws прод-сервера Parvane
  PARVANE_TG_APP_NAME       название для текстов (по умолчанию Parvane)
"""

import asyncio
import json
import logging
import os
import secrets
import sys
import time
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
# Сколько ждём нажатия кнопки; токены identity живут 10–15 мин, берём меньше.
PENDING_TTL_S = 300

TEXT_HELP = (
    f"Это бот подтверждения регистрации и входа в {APP_NAME}.\n\n"
    f"Откройте {APP_NAME}, нажмите «Create account», заполните ник и пароль — "
    "и на следующем экране нажмите «Open Telegram». Тогда я спрошу подтверждение."
)
TEXT_ASK = (
    "Кто-то запрашивает подтверждение в " + APP_NAME + " от вашего имени.\n\n"
    "Если это ВЫ только что нажали «Open Telegram» в приложении — нажмите "
    "«Подтвердить». Если вы ничего не запрашивали — нажмите «Отклонить»: "
    "кто-то знает ваш пароль, смените его в настройках."
)
TEXT_OK = "Аккаунт {user} подтверждён ✅\nВозвращайтесь в " + APP_NAME + " — вход произойдёт сам."
TEXT_OK_LOGIN = "Вход в аккаунт {user} подтверждён. Возвращайтесь в " + APP_NAME + "."
TEXT_REJECTED = "Отклонено. Если вы не запрашивали вход — смените пароль в " + APP_NAME + "."
TEXT_EXPIRED = "Запрос устарел. Начните заново в " + APP_NAME + " и нажмите Start по новой ссылке."
TEXT_FAIL = "Не получилось подтвердить: {error}\nНачните регистрацию в " + APP_NAME + " заново и нажмите Start по новой ссылке."
TEXT_DOWN = "Сервер " + APP_NAME + " сейчас недоступен, попробуйте через минуту."

# pending_id → {token, chat_id, tg_id, name, created}
PENDING: dict[str, dict] = {}


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


def purge_pending(now: float | None = None) -> None:
    now = now or time.time()
    for key in [k for k, v in PENDING.items() if now - v["created"] > PENDING_TTL_S]:
        PENDING.pop(key, None)


def sender_display(sender: dict) -> str:
    return sender.get("username") or " ".join(
        filter(None, [sender.get("first_name"), sender.get("last_name")])
    )


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
    purge_pending()
    # P-15: НЕ подтверждаем по Start. Кладём запрос в ожидание и спрашиваем явно.
    # callback_data ограничен 64 байтами, поэтому в кнопку кладём короткий
    # случайный id, а сам токен держим у себя.
    pending_id = secrets.token_urlsafe(12)
    PENDING[pending_id] = {
        "token": token,
        "chat_id": chat_id,
        "tg_id": int(sender["id"]),
        "name": sender_display(sender),
        "created": time.time(),
    }
    keyboard = json.dumps({"inline_keyboard": [[
        {"text": "✅ Подтвердить", "callback_data": f"c:{pending_id}"},
        {"text": "❌ Отклонить", "callback_data": f"r:{pending_id}"},
    ]]})
    tg_call("sendMessage", chat_id=chat_id, text=TEXT_ASK, reply_markup=keyboard)


async def handle_callback(callback: dict):
    cq_id = callback["id"]
    sender = callback.get("from") or {}
    data = callback.get("data") or ""
    message = callback.get("message") or {}
    chat_id = (message.get("chat") or {}).get("id")
    message_id = message.get("message_id")

    def finish(text: str, alert: str | None = None):
        try:
            tg_call("answerCallbackQuery", callback_query_id=cq_id, text=alert)
        except Exception as error:  # noqa: BLE001
            log.warning("answerCallbackQuery: %s", error)
        if chat_id is not None and message_id is not None:
            try:
                tg_call("editMessageText", chat_id=chat_id, message_id=message_id, text=text)
            except Exception as error:  # noqa: BLE001
                log.warning("editMessageText: %s", error)

    purge_pending()
    action, _, pending_id = data.partition(":")
    pending = PENDING.pop(pending_id, None)
    if action not in ("c", "r") or pending is None:
        finish(TEXT_EXPIRED)
        return
    # Кнопку обязан нажать тот же Telegram-пользователь, что запустил /start.
    if int(sender.get("id", 0)) != pending["tg_id"]:
        finish(TEXT_EXPIRED, alert="Это не ваш запрос")
        return
    if action == "r":
        log.info("отклонено tg %s", pending["tg_id"])
        finish(TEXT_REJECTED)
        return
    try:
        result = await confirm_via_gateway(pending["token"], pending["tg_id"], pending["name"])
    except Exception as error:  # noqa: BLE001 — любая сетевая ошибка = «сервер недоступен»
        log.error("gateway недоступен: %s", error)
        finish(TEXT_DOWN)
        return
    if result.get("ok"):
        user = result.get("user") or ""
        nick = user.split("@")[0] if user else "?"
        kind = result.get("kind") or "register"
        log.info("подтверждён %s (%s) для tg %s (%s)", user, kind, pending["tg_id"], pending["name"])
        text = TEXT_OK_LOGIN if kind == "login" else TEXT_OK
        finish(text.format(user=f"@{nick}"))
    else:
        log.warning("отказ для tg %s: %s", pending["tg_id"], result.get("error"))
        finish(TEXT_FAIL.format(error=result.get("error", "неизвестная ошибка")))


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
                None,
                lambda: tg_call(
                    "getUpdates", offset=offset, timeout=POLL_TIMEOUT_S,
                    allowed_updates='["message","callback_query"]',
                ),
            )
        except Exception as error:  # noqa: BLE001
            log.error("getUpdates: %s", error)
            await asyncio.sleep(5)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            message = update.get("message")
            callback = update.get("callback_query")
            try:
                if message and message.get("chat", {}).get("type") == "private":
                    await handle_message(message)
                elif callback:
                    await handle_callback(callback)
            except Exception as error:  # noqa: BLE001
                log.error("обработка обновления: %s", error)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    asyncio.run(main())
