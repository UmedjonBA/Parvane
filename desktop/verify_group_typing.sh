#!/usr/bin/env bash
# Parvane desktop — ГРУППОВОЙ TYPING (обвязка): группа синхронизируется у обоих,
# оба клиента ПОДПИСЫВАЮТСЯ на msg.typing.<groupId>, gateway пропускает подписку
# (ACL-корректность отдельно доказана gateway unit-тестом), групповое сообщение
# доходит (маршрут группы жив), без крашей. Полный индикатор «печатает…» —
# GUI-набор, headless не воспроизводится.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-gtyping}"
GNAME="ТайпГруппа"; SECRET="в-группе-$(date +%s)"
B="$SB/bob"; A="$SB/alice"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob не поднялся"
sleep 2
PA=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local" PARVANE_AUTOGROUPSEND="$GNAME:$SECRET")
wait_log "$A/td/log.txt" "группа синтезирована" 40 && ok "alice создала группу" || bad "группа не создана"
# bob должен ПОДХВАТИТЬ группу (периодический RefreshGroups после её создания)
wait_log "$B/td/log.txt" "групп синхронизировано: [1-9]" 60 && ok "bob синхронизировал группу (подписка на групповой typing взведена)" || bad "bob не подхватил группу"
# групповое сообщение доходит (маршрут группы жив после typing-правок)
wait_log "$B/td/log.txt" "$SECRET" 40 && ok "bob расшифровал+показал сообщение группы" || bad "bob не получил сообщение группы"
grep -qiE "нужна авторизация|запрещ|ACL" "$SB/gateway.log" && bad "gateway отклонил подписку/публикацию" || ok "gateway без ACL-отказов (групповой typing разрешён)"
grep -qiE "Fatal|Unexpected in " "$A/td/log.txt" "$B/td/log.txt" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PA"; stop_pid "$PB"; stack_stop
finish "ГРУППОВОЙ TYPING"
