#!/usr/bin/env bash
# Модуль «Музыка» (spec 039, 041; правило MUSIC-1): библиотека сервера, плеер с очередью, любимое, поиск,
# плеер вне модуля (виджет панели, полоса над лентой телефона), очередь после перезагрузки. Библиотеку играет
# поддельный сервер `scripts/fake_subsonic.mjs` за шардом music.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Числа библиотеки шард держит в памяти: сценарий меняет библиотеку и ждёт новых чисел
PARVANE_MUSIC_STATS_TTL_SECS=1 \
PARVANE_E2E_MUSIC=1 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_music.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
