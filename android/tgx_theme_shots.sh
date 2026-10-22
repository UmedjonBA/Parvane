#!/usr/bin/env bash
# Снимки встроенных тем X, перекрашенных схемами web (spec 031, T074): для проверки глазами — список чатов и «План»
# в каждой теме. Только debug-сборка (тема берётся из /data/local/tmp/parvane-theme, см. Parvane.applyDevTheme).
# После любого сценария со стеком (X вошла). В конце — тема по умолчанию (Gruvbox, ThemeId 11).
#   ./tgx_theme_shots.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-themes}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
. "$HERE/tgx_ui.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
# ThemeId X → схема web
THEMES="11:gruvbox-light 10:gruvbox-dark 9:nord-light 4:nord-dark 7:catppuccin-light 3:catppuccin-dark 6:solarized-light 5:solarized-dark 1:telegram-light 2:telegram-dark"
for t in $THEMES; do
  id="${t%%:*}"; name="${t#*:}"
  tgx_put parvane-theme "$id"
  tgx_stop; tgx_start
  tgx_logwait "тема \(dev\): $id" 60 && ok "тема $name применена" || { bad "тема $name не применена"; continue; }
  sleep 4; tgx_shot "$OUT/$name-chats.png"
  ui_tap '^(План|Plan)$' 10 >/dev/null 2>&1 && { sleep 3; tgx_shot "$OUT/$name-plan.png"; }
  [ -s "$OUT/$name-chats.png" ] && ok "$name: снимок" || bad "$name: снимка нет"
done
tgx_put parvane-theme 11; tgx_stop; tgx_start
tgx_logwait "тема \(dev\): 11" 60 || bad "тема по умолчанию не возвращена"
a shell rm -f /data/local/tmp/parvane-theme
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX THEMES"
