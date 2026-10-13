#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Ссылки облака для людей без аккаунта (spec 022): владелец создаёт ссылки,
# посетитель без входа открывает публичную страницу `/s/<id>#k=<ключ>`
# (второй вход сборки `s.html`; адрес gateway стенда страница берёт из
# `localStorage['parvane:gateway']` — только в диагностической сборке раннера)
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cloud_links.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
