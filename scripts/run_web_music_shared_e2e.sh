#!/usr/bin/env bash
# «Музыка», spec 041: общий плейлист двух аккаунтов (MUSIC-3), «Найти и скачать» по запросу с ходом, отменой и
# причиной отказа, «Загрузки на сервер», свои файлы. Библиотека — `scripts/fake_subsonic.mjs`, скачивание —
# `scripts/fake_music_fetch.mjs` (медленный трек и отказ с причиной) за шардом music.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Ход и очередь: одна задача разом; лимит суток с запасом на отменённые и отказы
PARVANE_E2E_MUSIC=1 \
PARVANE_E2E_MUSIC_ADD_PER_DAY=10 \
PARVANE_MUSIC_FETCH_PARALLEL=1 \
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_music_shared.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
