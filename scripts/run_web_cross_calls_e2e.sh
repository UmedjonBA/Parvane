#!/usr/bin/env bash
# Кросс-клиентский звонок web ↔ desktop (аудио, настоящий движок tg_owt на десктопе),
# оба клиента на v2 (пара call-web2-desktop2; v1-пара удалена с T110).
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Захват звука десктопа идёт с источника PulseAudio по умолчанию. Bluetooth-гарнитура
# в профиле без микрофона не отдаёт ни кадра — десктоп тогда не шлёт RTP вовсе, и
# сценарий падал «media is not flowing» (4 окт 2026). Берём первый не-Bluetooth вход
# либо монитор выхода (тишина тоже кодируется и идёт пакетами).
if [ -z "${PULSE_SOURCE:-}" ] && command -v pactl >/dev/null 2>&1; then
  if pactl info 2>/dev/null | grep -q '^Default Source: bluez_'; then
    SRC="$(pactl list short sources 2>/dev/null | awk '$2 !~ /^bluez_/ && $2 !~ /\.monitor$/ {print $2; exit}')"
    [ -n "$SRC" ] || SRC="$(pactl list short sources 2>/dev/null | awk '$2 !~ /^bluez_/ {print $2; exit}')"
    if [ -n "$SRC" ]; then
      export PULSE_SOURCE="$SRC"
      echo "источник звука по умолчанию — Bluetooth; для сценария взят $SRC"
    fi
  fi
fi
PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT="$ROOT/scripts/e2e_web_cross_calls.mjs" \
  "$ROOT/scripts/run_web_e2e.sh"
