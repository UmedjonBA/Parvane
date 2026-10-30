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


if __name__ == "__main__":
    unittest.main()
