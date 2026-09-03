#!/usr/bin/env bash
# «Удалить чат» (msg.chat.clear): история скрывается «для меня» на сервере и
# переживает reload; собеседник видит всё; новое сообщение возвращает чат без
# старой истории; «удалить для меня и X» стирает свои сообщения у собеседника.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_delete_chat.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
