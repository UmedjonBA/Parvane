#!/usr/bin/env bash
# Parvane — глобальный поиск по сообщениям на десктопе (локально, как в вебе):
# alice и bob обмениваются сообщениями с уникальной подстрокой; после рестарта
# alice (журнал воспроизведён) поиск PARVANE_AUTOSEARCH находит сообщения из
# обоих направлений, без учёта регистра, и не находит мусор.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="$(mktemp -d /tmp/pv-gsearch.XXXXXX)"
stack_start "$SB"
STAMP="$(date +%s)"
A="$SB/alice"; B="$SB/bob"; mkdir -p "$A/td" "$B/td"
BP=$(start_client "$B" bob@local)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob: устройство не готово"
AP=$(start_client "$A" alice@local PARVANE_AUTOSEND="bob@local:Needle-$STAMP-from-alice")
wait_log "$B/td/log.txt" "входящее msg .*alice@local.*Needle-$STAMP-from-alice" 40 && ok "bob получил сообщение alice" || bad "bob не получил"
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_AUTOSEND="alice@local:reply needle-$STAMP-from-bob")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*needle-$STAMP-from-bob" 40 && ok "alice получила ответ bob" || bad "alice не получила ответ"
stop_pid "$BP"; stop_pid "$AP"
# рестарт alice: поиск по журналу (регистр не важен: ищем NEEDLE)
AP=$(start_client "$A" alice@local PARVANE_AUTOSEARCH="NEEDLE-$STAMP:6")
wait_log "$A/td/log.txt" "локальный поиск «NEEDLE-$STAMP»: [0-9]+ совпадений" 40 && ok "поиск отработал" || bad "поиск не отработал"
N=$(grep -oE "локальный поиск «NEEDLE-$STAMP»: [0-9]+" "$A/td/log.txt" | head -1 | grep -oE "[0-9]+$")
[ "${N:-0}" -ge 2 ] && ok "найдены оба направления (N=$N)" || bad "найдено меньше двух (N=${N:-0})"
grep -q "autosearch «NEEDLE-$STAMP» → .*from-alice" "$A/td/log.txt" && ok "своё сообщение в результатах" || bad "своего сообщения нет"
grep -q "autosearch «NEEDLE-$STAMP» → .*from-bob" "$A/td/log.txt" && ok "входящее в результатах" || bad "входящего нет"
stop_pid "$AP"
AP=$(start_client "$A" alice@local PARVANE_AUTOSEARCH="nothing-here-$STAMP:6")
wait_log "$A/td/log.txt" "локальный поиск «nothing-here-$STAMP»: 0 совпадений" 40 && ok "мусор не находится" || bad "мусор нашёлся или поиск не отработал"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальные ошибки" || ok "без фатальных ошибок"
stop_pid "$AP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ГЛОБАЛЬНЫЙ ПОИСК"
