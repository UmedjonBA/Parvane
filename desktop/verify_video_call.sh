#!/usr/bin/env bash
# Parvane — e2e ВИДЕОЗВОНКА (реальная камера V4L2, без дисплея). alice видео-звонит
# bob (PARVANE_REAL_MEDIA=1, media=video). Проверяем ПО СЧЁТЧИКАМ КАДРОВ (рендер в
# окне не нужен): alice захватывает камеру, bob ПРИНИМАЕТ удалённое видео (кадры
# идут => негоциация+кодек+передача+декод работают). Одна камера => одно
# направление (alice->bob); двунаправленное видео = две камеры/машины.
# Рендер удалённого видео в окне — отдельный шаг (нужен дисплей). Требует камеру
# (/dev/video0, группа video). Сигналы — конверты v2 через gateway; перед звонком
# — обмен сообщениями (звонить можно только тому, с кем была переписка, D-08).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
[ -e /dev/video0 ] || { echo "нет камеры /dev/video0 — тест требует камеру"; exit 2; }
stack_start "${SCRATCH:-/tmp/parvane-video-call}"
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"

pair_exchange "$A" alice@local "$B" bob@local
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 PARVANE_AUTOACCEPT=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_REAL_MEDIA=1 PARVANE_AUTOCALL=bob@local:video)
# ждём устойчивого потока: bob получил хотя бы 60 кадров (лог печатает 1, 60, 120…)
wait_log "$BL" 'удалённое видео — кадров получено: 60' 90

grep -qa 'звонок → Active' "$AL" && ok "видеозвонок соединился (alice Active)" || bad "alice не Active"
grep -qa 'звонок → Active' "$BL" && ok "видеозвонок соединился (bob Active)" || bad "bob не Active"
grep -qa 'видео-трек добавлен (камера)' "$AL" && ok "alice: камера открыта, видео-трек добавлен" || bad "alice: нет видео-трека"
grep -qa 'камера — кадров захвачено' "$AL" && ok "alice: камера ЗАХВАТЫВАЕТ кадры" || bad "alice: камера не даёт кадров"
grep -qa 'удалённый ВИДЕО-трек подключён' "$BL" && ok "bob: удалённый видео-трек подключён" || bad "bob: нет удалённого видео-трека"
grep -qa 'удалённое видео — кадров получено: 60' "$BL" && ok "bob: ПРИНИМАЕТ видео (устойчивый поток ≥60 кадров)" || bad "bob: видео не идёт устойчиво"

stop_pid "$AP"; stop_pid "$BP"; stack_stop
finish "ВИДЕОЗВОНОК e2e (рендер в окне — с дисплеем)"
