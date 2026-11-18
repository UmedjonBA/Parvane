#!/usr/bin/env bash
# «Профиль» по макету (spec 041 E3): на компьютере — колонка разделов и экран справа во всё окно, «Обзор»,
# «Оформление» (режим, размер текста, фон чатов), возвраты «Назад» по карте `LeftColumn.tsx`, «Копия ключей»,
# «О приложении», выгрузка и выход из списка разделов; на телефоне — аккаунт с плитками и разделы списком.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_profile.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
