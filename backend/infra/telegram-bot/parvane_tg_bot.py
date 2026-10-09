#!/usr/bin/env python3
"""Telegram-бот Parvane: подтверждение регистрации и входа, ключ восстановления.

Клиент показывает deep link t.me/<bot>?start=<token>; пользователь жмёт Start,
бот получает `/start <token>` и показывает ЯВНЫЙ запрос подтверждения с кнопками
«Подтвердить» / «Отклонить». Только по нажатию «Подтвердить» (callback_query)
бот через WSS gateway (как обычный pre-auth клиент) вызывает
identity.telegram.confirm с общим секретом; identity привязывает Telegram-аккаунт
к pending-нику или подтверждает вход. Раньше подтверждение шло сразу по Start —
атакующий, знающий пароль, мог прислать жертве ссылку и получить второй фактор
одним её нажатием (находка P-15).

Ключ восстановления (spec 015): бот забирает у сервера сообщения для владельцев
(`identity.telegram.pull`) — сам ключ сразу после создания аккаунта и просьбу
прислать его при входе с нового устройства; ответ владельца с ключом передаёт
серверу (`identity.telegram.reply`), тот проверяет ключ и отдаёт новому
устройству. Ключ в журнал бота не пишется.

Живёт на хосте с доступом к api.telegram.org (с прод-сервера Parvane Telegram
недоступен). Зависимости: python3 + websockets (apt: python3-websockets).

Переменные окружения (см. tg-bot.env.example):
  PARVANE_TG_BOT_TOKEN      токен бота от @BotFather
  PARVANE_TELEGRAM_SECRET   общий секрет с identity (PARVANE_TELEGRAM_SECRET)
  PARVANE_GATEWAY_URL       wss://<host>:<port>/ws прод-сервера Parvane
  PARVANE_TG_APP_NAME       название для текстов (по умолчанию Parvane)
  PARVANE_TG_API_BASE       адрес Bot API (по умолчанию https://api.telegram.org;
                            подменяется в проверке бота на локальном стенде)
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

API_BASE = os.environ.get("PARVANE_TG_API_BASE", "").strip().rstrip("/") or "https://api.telegram.org"
API = f"{API_BASE}/bot{BOT_TOKEN}"
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

TEXT_KEY = (
    "🔑 Ключ восстановления аккаунта {user} в " + APP_NAME + ":\n\n"
    "<code>{key}</code>\n\n"
    "Не удаляйте это сообщение. Когда вы войдёте в " + APP_NAME + " с нового устройства, "
    "я попрошу прислать этот ключ — после этого на устройстве появятся ваши чаты и план.\n\n"
    "Никому его не пересылайте: с этим ключом и паролем можно войти в ваш аккаунт."
)
TEXT_KEY_ASK = (
    "Вход в аккаунт {user} в " + APP_NAME + " с нового устройства{client}.\n\n"
    "Если это вы — ответьте на это сообщение ключом восстановления (я присылал его "
    "сюда, в этот чат). После этого на новом устройстве появятся ваши чаты и план.\n\n"
    "Если входите не вы — ничего не присылайте и смените пароль в " + APP_NAME + "."
)
TEXT_KEY_OK = "Ключ принят ✅\nВозвращайтесь в " + APP_NAME + " — устройство подключится само."
TEXT_KEY_BAD = (
    "Этот ключ не подошёл. Скопируйте ключ целиком из моего сообщения "
    "«Ключ восстановления аккаунта…» и пришлите ещё раз."
)
TEXT_KEY_LIMIT = "Слишком много попыток. Подождите минуту и пришлите ключ ещё раз."

# Опрос сервера: сколько сервер держит запрос в ожидании сообщений и пауза после сбоя
PULL_WAIT_MS = 7000
PULL_RETRY_S = 5

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


# ── Протокол v2 (spec 007): минимальный protobuf-кодек без зависимостей ──────
# Бот шлёт один метод канала PRE — `identity.account.confirm_telegram` — кадрами
# `Frame{hello}` → `Frame{welcome}` → `Frame{request}` → `Frame{response}`
# (proto/parvane/core/v2/frame.proto, identity/v2/identity.proto). Номера полей
# ниже — из схемы; генерировать pb2 не нужно (на VPS старый runtime protobuf).
PROTO_MAJOR = 2
PROTO_MINOR = 0
CHANNEL_IDENTIFIED = 1
METHOD_CONFIRM_TELEGRAM = "identity.account.confirm_telegram"
METHOD_TELEGRAM_PULL = "identity.telegram.pull"
METHOD_TELEGRAM_REPLY = "identity.telegram.reply"
ERROR_RATE_LIMITED = 5
ERROR_TEXT = {
    1: "неверный запрос", 2: "Telegram уже привязан к другому аккаунту или неверный секрет",
    3: "ссылка подтверждения не найдена или устарела", 4: "уже подтверждено",
    5: "слишком много попыток, попробуйте позже", 6: "сервер требует обновления бота",
    11: "сервер временно недоступен", 12: "ссылка подтверждения устарела",
}


def _varint(n: int) -> bytes:
    out = bytearray()
    n &= (1 << 64) - 1
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _field_varint(num: int, value: int) -> bytes:
    return _varint((num << 3) | 0) + _varint(value)


def _field_bytes(num: int, value: bytes) -> bytes:
    return _varint((num << 3) | 2) + _varint(len(value)) + value


def _field_str(num: int, value: str) -> bytes:
    return _field_bytes(num, value.encode("utf-8"))


def _read_varint(buf: bytes, i: int) -> tuple[int, int]:
    shift, n = 0, 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, i
        shift += 7
        if shift > 63:
            raise ValueError("varint")


def _fields(buf: bytes) -> dict:
    """Разобрать сообщение в {номер поля: [значения]}; bytes — для длинных полей."""
    out: dict = {}
    i = 0
    while i < len(buf):
        key, i = _read_varint(buf, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _read_varint(buf, i)
        elif wt == 2:
            ln, i = _read_varint(buf, i)
            v = buf[i:i + ln]
            i += ln
        elif wt == 1:
            v, i = buf[i:i + 8], i + 8
        elif wt == 5:
            v, i = buf[i:i + 4], i + 4
        else:
            raise ValueError("wire type")
        out.setdefault(num, []).append(v)
    return out


def _first(fields: dict, num: int, default=None):
    vals = fields.get(num)
    return vals[0] if vals else default


def v2_hello_frame() -> bytes:
    client = _field_str(1, "bot") + _field_str(2, "1")
    hello = _field_varint(1, PROTO_MINOR) + _field_bytes(3, client) + _field_varint(4, CHANNEL_IDENTIFIED)
    return _field_varint(1, PROTO_MAJOR) + _field_bytes(10, hello)


def v2_request_frame(req_id: int, method: str, body: bytes, timeout_ms: int) -> bytes:
    request = _field_varint(1, req_id) + _field_str(2, method) + _field_bytes(3, body) + _field_varint(4, timeout_ms)
    return _field_varint(1, PROTO_MAJOR) + _field_bytes(20, request)


def v2_parse_response(frame: bytes, req_id: int):
    """(ok_body | None, error_code | None) для Frame{response} с нужным id; None — другой кадр."""
    f = _fields(frame)
    response = _first(f, 21)
    if response is None:
        return None
    r = _fields(response)
    if _first(r, 1, 0) != req_id:
        return None
    if 2 in r:
        return (_first(r, 2), None)
    err = _fields(_first(r, 3, b""))
    return (None, _first(err, 1, 0))


def confirm_request_body(secret: str, token: str, telegram_id: int, telegram_name: str) -> bytes:
    return (_field_str(1, secret) + _field_str(2, token)
            + _field_varint(3, telegram_id) + _field_str(4, telegram_name))


def parse_confirm_response(body: bytes) -> dict:
    f = _fields(body)
    user = _first(f, 1, b"").decode("utf-8", "replace")
    action = _first(f, 2, b"").decode("utf-8", "replace")
    return {"ok": True, "user": user, "kind": action or "register"}


async def gateway_call(method: str, body: bytes, timeout_ms: int = 5000):
    """Один запрос канала PRE: (тело ответа | None, код ошибки | None)."""
    wait_s = max(GATEWAY_TIMEOUT_S, timeout_ms / 1000 + 5)
    async with websockets.connect(GATEWAY_URL, open_timeout=GATEWAY_TIMEOUT_S, max_size=8 * 1024 * 1024) as ws:
        await ws.send(v2_hello_frame())
        welcome = await asyncio.wait_for(ws.recv(), GATEWAY_TIMEOUT_S)
        if not isinstance(welcome, (bytes, bytearray)) or 11 not in _fields(bytes(welcome)):
            raise RuntimeError("gateway не ответил Welcome v2")
        await ws.send(v2_request_frame(1, method, body, timeout_ms))
        while True:
            raw = await asyncio.wait_for(ws.recv(), wait_s)
            if not isinstance(raw, (bytes, bytearray)):
                continue
            parsed = v2_parse_response(bytes(raw), 1)
            if parsed is not None:
                return parsed


async def confirm_via_gateway(token: str, telegram_id: int, telegram_name: str) -> dict:
    body = confirm_request_body(SECRET, token, telegram_id, telegram_name)
    try:
        ok_body, code = await gateway_call(METHOD_CONFIRM_TELEGRAM, body)
    except RuntimeError as error:
        return {"ok": False, "error": str(error)}
    if ok_body is not None:
        return parse_confirm_response(ok_body)
    return {"ok": False, "code": code, "error": ERROR_TEXT.get(code, f"ошибка сервера (код {code})")}


# ── Ключ восстановления (spec 015) ──────────────────────────────────────────

def pull_request_body(secret: str, acks: list[int], wait_ms: int) -> bytes:
    return (_field_str(1, secret) + b"".join(_field_varint(2, ack) for ack in acks)
            + _field_varint(3, wait_ms))


def parse_pull_response(body: bytes) -> list[dict]:
    out = []
    for raw in _fields(body).get(1, []):
        f = _fields(raw)
        text = lambda num: _first(f, num, b"").decode("utf-8", "replace")  # noqa: E731
        out.append({
            "id": _first(f, 1, 0), "telegram_id": _first(f, 2, 0), "kind": text(3),
            "user": text(4), "recovery_key": text(5), "client": text(6),
        })
    return out


def reply_request_body(secret: str, telegram_id: int, text: str) -> bytes:
    return _field_str(1, secret) + _field_varint(2, telegram_id) + _field_str(3, text)


def parse_reply_response(body: bytes) -> dict:
    f = _fields(body)
    return {
        "result": _first(f, 1, b"").decode("utf-8", "replace"),
        "user": _first(f, 2, b"").decode("utf-8", "replace"),
    }


def nick_of(user: str) -> str:
    return "@" + (user.split("@")[0] if user else "?")


def html_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def deliver(message: dict) -> None:
    """Сообщение сервера — в чат владельца (личный чат: chat_id = telegram_id)."""
    chat_id = message["telegram_id"]
    user = html_escape(nick_of(message["user"]))
    if message["kind"] == "key":
        tg_call("sendMessage", chat_id=chat_id, parse_mode="HTML",
                text=TEXT_KEY.format(user=user, key=html_escape(message["recovery_key"])))
    elif message["kind"] == "ask":
        client = f" ({html_escape(message['client'])})" if message["client"] else ""
        tg_call("sendMessage", chat_id=chat_id, parse_mode="HTML",
                text=TEXT_KEY_ASK.format(user=user, client=client),
                reply_markup=json.dumps({
                    "force_reply": True, "input_field_placeholder": "Ключ восстановления",
                }))
    else:
        log.warning("неизвестный вид сообщения сервера: %s", message["kind"])


async def pull_loop():
    """Забирать у сервера сообщения для владельцев и слать их в Telegram."""
    loop = asyncio.get_running_loop()
    acks: list[int] = []
    while True:
        try:
            body = pull_request_body(SECRET, acks, PULL_WAIT_MS)
            ok_body, code = await gateway_call(METHOD_TELEGRAM_PULL, body, PULL_WAIT_MS + 2000)
        except Exception as error:  # noqa: BLE001 — сервер недоступен: повторим
            log.warning("опрос сервера: %s", error)
            await asyncio.sleep(PULL_RETRY_S)
            continue
        if ok_body is None:
            log.warning("опрос сервера: код ошибки %s", code)
            await asyncio.sleep(PULL_RETRY_S)
            continue
        acks = []
        for message in parse_pull_response(ok_body):
            try:
                await loop.run_in_executor(None, deliver, message)
                log.info("сообщение %s (%s) доставлено tg %s", message["id"], message["kind"], message["telegram_id"])
            except Exception as error:  # noqa: BLE001
                # Владелец мог заблокировать бота — сервер повторит и снимет по сроку
                log.warning("сообщение %s не доставлено tg %s: %s", message["id"], message["telegram_id"], error)
                continue
            acks.append(message["id"])


async def handle_key_reply(chat_id: int, telegram_id: int, text: str) -> bool:
    """Текст владельца — ключ восстановления? True — сервер ждал ключ (ответ боту дан)."""
    try:
        ok_body, code = await gateway_call(METHOD_TELEGRAM_REPLY, reply_request_body(SECRET, telegram_id, text))
    except Exception as error:  # noqa: BLE001
        log.error("gateway недоступен: %s", error)
        tg_call("sendMessage", chat_id=chat_id, text=TEXT_DOWN)
        return True
    if ok_body is None:
        if code == ERROR_RATE_LIMITED:
            tg_call("sendMessage", chat_id=chat_id, text=TEXT_KEY_LIMIT)
            return True
        log.warning("ответ с ключом tg %s: код ошибки %s", telegram_id, code)
        return False
    result = parse_reply_response(ok_body)["result"]
    if result == "ok":
        log.info("ключ восстановления принят от tg %s", telegram_id)
        tg_call("sendMessage", chat_id=chat_id, text=TEXT_KEY_OK)
        return True
    if result == "bad_key":
        tg_call("sendMessage", chat_id=chat_id, text=TEXT_KEY_BAD)
        return True
    return False


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
        # Не команда: возможно, это ключ восстановления в ответ на просьбу бота
        if text and await handle_key_reply(chat_id, int(sender.get("id", 0)), text):
            return
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
    puller = asyncio.create_task(pull_loop())  # noqa: F841 — ссылка держит задачу
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
