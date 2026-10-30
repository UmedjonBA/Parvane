"""Проверки логики бота без сети: python3 -m unittest test_parvane_tg_bot (нужен websockets)."""
import os
import sys
import types
import unittest

try:
    import websockets  # noqa: F401
except ImportError:  # логика фильтра от сети не зависит
    sys.modules["websockets"] = types.ModuleType("websockets")

os.environ.setdefault("PARVANE_TG_BOT_TOKEN", "t")
os.environ.setdefault("PARVANE_TELEGRAM_SECRET", "s")
os.environ.setdefault("PARVANE_GATEWAY_URL", "wss://example.invalid/ws")

import parvane_tg_bot as bot  # noqa: E402


class KeyReplyFilter(unittest.TestCase):
    def test_format(self):
        self.assertTrue(bot.looks_like_recovery_key("ABCD-EFGH-" + "-".join(["2345"] * 8)))
        self.assertFalse(bot.looks_like_recovery_key("мой пароль 12345"))
        self.assertFalse(bot.looks_like_recovery_key("ABCD-EFGH"))

    def test_requires_ask_and_rate_limit(self):
        bot.ASKED.clear()
        bot.KEY_REPLIES.clear()
        self.assertFalse(bot.key_reply_allowed(7, 1000.0), "просьбы не было")
        bot.ASKED[7] = 1000.0
        for _ in range(bot.KEY_REPLY_MAX):
            self.assertTrue(bot.key_reply_allowed(7, 1001.0))
        self.assertFalse(bot.key_reply_allowed(7, 1002.0), "лимит попыток")
        self.assertFalse(bot.key_reply_allowed(7, 1000.0 + bot.ASK_TTL_S + 5), "просьба устарела")


class AskBinding(unittest.TestCase):
    """A0023-1: ключ уходит запросу, на сообщение которого ответил владелец."""

    def setUp(self):
        bot.ASK_REQUESTS.clear()

    def test_single_request_needs_no_quote(self):
        bot.remember_ask(7, 11, 501, 1000.0)
        self.assertEqual(bot.resolve_ask(7, 0, 1001.0), 11)

    def test_several_requests_need_the_quoted_message(self):
        bot.remember_ask(7, 11, 501, 1000.0)
        bot.remember_ask(7, 12, 502, 1001.0)
        self.assertIsNone(bot.resolve_ask(7, 0, 1002.0), "неясно, чей ответ")
        self.assertIsNone(bot.resolve_ask(7, 999, 1002.0), "ответ на постороннее сообщение")
        self.assertEqual(bot.resolve_ask(7, 501, 1002.0), 11)
        self.assertEqual(bot.resolve_ask(7, 502, 1002.0), 12)

    def test_expired_requests_are_forgotten(self):
        bot.remember_ask(7, 11, 501, 1000.0)
        self.assertIsNone(bot.resolve_ask(7, 501, 1000.0 + bot.ASK_TTL_S + 1))

    def test_wire_fields(self):
        body = bot.reply_request_body("s", 5, "KEY", 42)
        self.assertEqual(bot._first(bot._fields(body), 4), 42)
        self.assertNotIn(4, bot._fields(bot.reply_request_body("s", 5, "KEY")))
        raw = bot._field_varint(1, 9) + bot._field_varint(7, 42) + bot._field_str(8, "123456")
        parsed = bot.parse_pull_response(bot._field_bytes(1, raw))
        self.assertEqual((parsed[0]["request_id"], parsed[0]["code"]), (42, "123456"))


if __name__ == "__main__":
    unittest.main()
