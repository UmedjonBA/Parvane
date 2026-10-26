#!/usr/bin/env bash
# Память и плавность X (отзыв 26 окт 2026: «нет утечек памяти и тормозов»). После tgx_web_parity_shots.sh (его аккаунт
# с данными: чаты, группа, «План», заметки, холст с картинкой и ссылкой). ROUNDS кругов по всем разделам кнопками
# панели: Чаты → «План» (Сегодня, День, Мес, Год, Список, Здоровье) → «Знания» (заметки, граф, холст «Доска», файлы)
# → «Профиль». После прогрева и после каждого круга — dumpsys meminfo (PSS, Java/Native heap, число View и
# Activity); кадры — dumpsys gfxinfo за все круги после прогрева.
# Утечка: память или число View растут от круга к кругу (сравнение второго круга с последним).
#   ./tgx_perf_flow.sh [OUT_DIR]   ROUNDS=8 (по умолчанию)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-perf}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
. "$HERE/tgx_ui.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
ROUNDS="${ROUNDS:-8}"
# Пороги: прирост от второго круга к последнему
MAX_PSS_GROWTH_KB="${MAX_PSS_GROWTH_KB:-30000}"
MAX_HEAP_GROWTH_KB="${MAX_HEAP_GROWTH_KB:-15000}"
MAX_VIEWS_GROWTH="${MAX_VIEWS_GROWTH:-300}"
MAX_JANK_PCT="${MAX_JANK_PCT:-35}"
MAX_P99_MS="${MAX_P99_MS:-300}"

tgx_start; tgx_logwait "v2: готов" 90 >/dev/null || bad "сессия не поднялась"; sleep 5
tab() { ui_tap "^($1)\$" 10 >/dev/null || echo "   нет на экране: $1"; }
close_sheet() { ui_dump; [ -n "$(ui_bounds '^(Закрыть|Close)$')" ] && tab 'Закрыть|Close'; }
round() {
  tab 'Чаты|Chats'; sleep 1
  a shell input swipe 540 1600 540 700 300; a shell input swipe 540 700 540 1600 300
  tab 'План|Planner'; sleep 1
  for v in 'Сегодня|Today' 'День|Day' 'Мес|Mon' 'Год|Year' 'Список|List'; do tab "$v"; sleep 1; done
  a shell input swipe 540 1600 540 800 300
  tab 'Здоровье|Health'; sleep 1; a shell input swipe 540 1600 540 800 300
  tab 'Календарь|Calendar'; sleep 1
  tab 'Знания|Knowledge'; sleep 1
  tab 'Граф|Graph'; sleep 2; a shell input swipe 300 1200 700 900 300
  tab 'Холст|Canvas'; sleep 1; tab 'Доска'; sleep 2; close_sheet
  a shell input swipe 300 1300 600 1000 300
  tab 'Файлы|Files'; sleep 1
  tab 'Заметки|Notes'; sleep 1
  tab 'Профиль|Profile'; sleep 1; a shell input swipe 540 1600 540 800 300
}
mem() { # $1 — метка; печатает «PSS JAVA NATIVE VIEWS ACTIVITIES»
  sleep 4
  local m; m=$(a shell dumpsys meminfo "$TGX_PKG")
  echo "$m" > "$OUT/meminfo-$1.txt"
  local pss java native views acts
  pss=$(echo "$m" | awk '/TOTAL PSS:/ {print $3; exit}')
  [ -z "$pss" ] && pss=$(echo "$m" | awk '/^ *TOTAL / {print $2; exit}')
  java=$(echo "$m" | awk '/Java Heap:/ {print $3; exit}')
  native=$(echo "$m" | awk '/Native Heap:/ {print $3; exit}')
  views=$(echo "$m" | awk '/Views:/ {print $2; exit}')
  acts=$(echo "$m" | awk '/Activities:/ {for (i=1;i<NF;i++) if ($i=="Activities:") print $(i+1); exit}')
  echo "$pss ${java:-0} ${native:-0} ${views:-0} ${acts:-0}"
}

echo "-- прогрев (2 круга)"
round; round
a shell dumpsys gfxinfo "$TGX_PKG" reset >/dev/null
read -r P0 J0 N0 V0 A0 < <(mem r0)
echo "   после прогрева: PSS ${P0} КБ, Java ${J0} КБ, Native ${N0} КБ, View ${V0}, Activity ${A0}"
first=""
for i in $(seq 1 "$ROUNDS"); do
  round
  read -r P J N V A < <(mem "r$i")
  echo "   круг $i: PSS ${P} КБ, Java ${J} КБ, Native ${N} КБ, View ${V}, Activity ${A}"
  [ "$i" = 2 ] && first="$P $J $N $V"
done
read -r P2 J2 N2 V2 <<< "$first"
GFX=$(a shell dumpsys gfxinfo "$TGX_PKG"); echo "$GFX" > "$OUT/gfxinfo.txt"
FRAMES=$(echo "$GFX" | awk -F': ' '/Total frames rendered/ {print $2; exit}')
JANK=$(echo "$GFX" | awk '/Janky frames:/ {gsub(/[()%]/,"",$4); print $4; exit}')
P90=$(echo "$GFX" | awk '/^90th percentile/ {gsub(/ms/,"",$3); print $3; exit}')
P99=$(echo "$GFX" | awk '/^99th percentile/ {gsub(/ms/,"",$3); print $3; exit}')
echo "   кадры: ${FRAMES:-?}, рывки ${JANK:-?}%, 90-й перцентиль ${P90:-?} мс, 99-й ${P99:-?} мс"

dp=$((P - P2)); dh=$(( (J + N) - (J2 + N2) )); dv=$((V - V2))
echo "   прирост круги 2→$ROUNDS: PSS ${dp} КБ, Java+Native ${dh} КБ, View ${dv}"
[ "$dp" -le "$MAX_PSS_GROWTH_KB" ] && ok "память (PSS) не растёт от круга к кругу (+${dp} КБ)" || bad "PSS растёт: +${dp} КБ за $((ROUNDS - 2)) кругов"
[ "$dh" -le "$MAX_HEAP_GROWTH_KB" ] && ok "кучи Java+Native не растут (+${dh} КБ)" || bad "кучи растут: +${dh} КБ"
[ "$dv" -le "$MAX_VIEWS_GROWTH" ] && ok "число View не растёт (+${dv})" || bad "View копятся: +${dv}"
[ "${A:-1}" -le 2 ] && ok "Activity не копятся (${A})" || bad "Activity копятся: ${A}"
[ -n "$JANK" ] && [ "${JANK%.*}" -le "$MAX_JANK_PCT" ] && ok "рывков ${JANK}% (порог ${MAX_JANK_PCT}%)" || bad "рывков ${JANK:-?}%"
[ -n "$P99" ] && [ "$P99" -le "$MAX_P99_MS" ] && ok "99-й перцентиль кадра ${P99} мс" || bad "99-й перцентиль кадра ${P99:-?} мс"
tgx_no_crash
finish "TGX PERF"
