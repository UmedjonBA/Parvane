#!/usr/bin/env bash
# Parvane — e2e ВИДЕОЗВОНКА (реальная камера V4L2, без дисплея). alice видео-звонит
# bob (PARVANE_REAL_MEDIA=1, media=video). Проверяем ПО СЧЁТЧИКАМ КАДРОВ (рендер в
# окне не нужен): alice захватывает камеру, bob ПРИНИМАЕТ удалённое видео (кадры
# идут => негоциация+кодек+передача+декод работают). Одна камера => одно
# направление (alice->bob); двунаправленное видео = две камеры/машины.
# Рендер удалённого видео в окне — отдельный шаг (нужен дисплей). Требует камеру
# (/dev/video0, группа video) + nats+identity+call.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }
[ -e /dev/video0 ] || { echo "нет камеры /dev/video0 — тест требует камеру"; exit 2; }
nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' \
    >/dev/null 2>&1 || { echo "нет бэкенда — запусти nats+identity+call"; exit 2; }

pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
sleep 2
B=$(mktemp -d /tmp/pv-vv-b.XXXXXX); A=$(mktemp -d /tmp/pv-vv-a.XXXXXX)
env QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_REAL_MEDIA=1 \
  PARVANE_AUTOLOGIN='bob@local:test' PARVANE_AUTOACCEPT=1 \
  "$BIN" -workdir "$B/td" >"$B/out.log" 2>&1 &
sleep 7
env QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_REAL_MEDIA=1 \
  PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOCALL='bob@local:video' \
  "$BIN" -workdir "$A/td" >"$A/out.log" 2>&1 &
AL="$A/td/log.txt"; BL="$B/td/log.txt"
# ждём устойчивого потока: bob получил хотя бы 60 кадров (лог печатает 1, 60, 120…)
for i in $(seq 1 30); do
  grep -qa 'удалённое видео — кадров получено: 60' "$BL" 2>/dev/null && break
  sleep 1
done

grep -qa 'звонок → Active' "$AL" && ok "видеозвонок соединился (alice Active)" || bad "alice не Active"
grep -qa 'звонок → Active' "$BL" && ok "видеозвонок соединился (bob Active)" || bad "bob не Active"
grep -qa 'видео-трек добавлен (камера)' "$AL" && ok "alice: камера открыта, видео-трек добавлен" || bad "alice: нет видео-трека"
grep -qa 'камера — кадров захвачено' "$AL" && ok "alice: камера ЗАХВАТЫВАЕТ кадры" || bad "alice: камера не даёт кадров"
grep -qa 'удалённый ВИДЕО-трек подключён' "$BL" && ok "bob: удалённый видео-трек подключён" || bad "bob: нет удалённого видео-трека"
grep -qa 'удалённое видео — кадров получено: 60' "$BL" && ok "bob: ПРИНИМАЕТ видео (устойчивый поток ≥60 кадров)" || bad "bob: видео не идёт устойчиво"

pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
if [ "$RC" -eq 0 ]; then printf '\033[32mВИДЕОЗВОНОК e2e: ПОТОК ИДЁТ (рендер в окне — с дисплеем)\033[0m\n'
else printf '\033[31mВИДЕОЗВОНОК e2e: ПРОВАЛЫ\033[0m\n'; fi
exit $RC
