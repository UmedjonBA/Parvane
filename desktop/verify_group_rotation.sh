#!/usr/bin/env bash
# Фаза 3 — РОТАЦИЯ ключа группы при исключении участника (forward secrecy), группа v2.
# alice(owner)+bob+carol. alice шлёт msg1 (оба читают), затем исключает carol записью
# журнала группы (хук AUTOADMIN remove) — это новая эпоха группы; msg2 alice шлёт
# уже ключом новой эпохи. Проверяем:
#   1) до исключения: и bob, и carol прочитали msg1;
#   2) carol исключена, у alice началась новая эпоха группы (лог движка);
#   3) ПОСЛЕ смены эпохи: bob прочитал msg2;
#   4) carol НЕ получила msg2 (вне группы и без ключа новой эпохи);
#   5) открытого текста msg2 нет в БД messenger.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
stack_start "${SCRATCH:-/tmp/parvane-grprot}"
STAMP="$(date +%s)"; GNAME="РотГруппа"
M1="до-удаления-$STAMP"; M2="после-ротации-$STAMP"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"
AL="$A/td/log.txt"; BL="$B/td/log.txt"; CL="$C/td/log.txt"

# bob и carol первыми: группу v2 создают только из участников с журналом устройств v2.
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
wait_log "$CL" "v2: готов" 90 || bad "carol: v2 не поднялся"
# Хуки: группа и msg1 сразу после входа, исключение carol — через ~11 с,
# msg2 (AUTOGROUPSEND2) — позже, уже в новой эпохе.
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOGROUP=$GNAME:bob@local,carol@local" \
  "PARVANE_AUTOGROUPSEND=$GNAME:$M1" "PARVANE_AUTOGROUPSEND2=$GNAME:$M2" \
  "PARVANE_AUTOADMIN=$GNAME;remove:carol@local")

# msg1 у обоих (до исключения).
wait_log "$BL" "групповое .* от alice@local: $M1" 90 && ok "bob прочитал msg1 (до исключения)" || bad "bob не получил msg1"
wait_log "$CL" "групповое .* от alice@local: $M1" 30 && ok "carol прочитала msg1 (до исключения)" || bad "carol не получила msg1"

GID=$(group_gid "$AL" "$GNAME")
[ -n "$GID" ] && ok "группа v2 создана ($GID)" || bad "GID не найден"
wait_log "$AL" "админ-действие 'remove' над carol@local в .* → ok" 40 \
  && ok "carol исключена записью журнала группы" || bad "не удалось исключить carol"
ROTATED="v2: новая эпоха группы ${GID#v2g:}: [2-9]"
wait_log "$AL" "$ROTATED" 45 && ok "alice начала новую эпоху группы после исключения" || bad "новой эпохи не было"
wait_log "$BL" "групповое .* от alice@local: $M2" 60 && ok "bob прочитал msg2 в новой эпохе" \
  || bad "bob НЕ прочитал msg2 — ключ новой эпохи не дошёл!"
sleep 3
stop_pid "$AP"; stop_pid "$BP"; stop_pid "$CP"

echo "── ALICE ──"; grep -aE "Parvane: (AUTOGROUPSEND2?|v2: новая эпоха|админ-действие)" "$AL" 2>/dev/null | head
echo "── BOB ──"; grep -aE "групповое .* (: $M1|: $M2)" "$BL" 2>/dev/null | head
echo "── CAROL ──"; grep -aE "групповое .* (: $M1|: $M2)|группа .* снята" "$CL" 2>/dev/null | head
echo "──────────"

if grep -qa "групповое .* от alice@local: $M2" "$CL"; then
  bad "carol ПОЛУЧИЛА msg2 после исключения — forward secrecy НАРУШЕНА!"
else
  ok "carol НЕ получила msg2 (вне группы, ключа новой эпохи нет)"
fi
grep -qa "группа $GID снята" "$CL" && ok "у carol группа снята" || bad "у carol группа не снята"
grep -qa -e "$M1" -e "$M2" "$SB"/messenger.db* 2>/dev/null \
  && bad "открытый текст группы в БД messenger" || ok "открытого текста группы в БД messenger нет"
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" "$CL" && bad "фатальная ошибка" || ok "без фатальных ошибок"

clients_kill "$SB"; stack_stop
finish "РОТАЦИЯ ГРУПП"
