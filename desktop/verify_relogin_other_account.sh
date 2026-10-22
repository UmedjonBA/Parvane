#!/usr/bin/env bash
# Parvane — изоляция аккаунтов в одном процессе (ревью безопасности 21 окт 2026, вечер; пункты 1.1, 1.2).
# Состояние клиента глобальное на процесс: раньше выход (и со стиранием) снимал только учётные данные, и
# отложенное прежнего аккаунта с взведённым таймером уходило от имени следующего, а его черновики и отложенные
# переносились в журнал состояния следующего; файлы tdata/parvane-* без адреса в имени читал следующий аккаунт.
#
#   1) выход со стиранием: alice ставит черновик и отложенное carol на +30 с (хук PARVANE_AUTOSEED), выходит со
#      стиранием (PARVANE_AUTOLOGOUT=wipe), в том же процессе входит bob (PARVANE_AUTOLOGIN_NEXT):
#      carol ничего не получает, журнал состояния bob подключается пустым, данных alice в tdata нет;
#   2) выход как при отказе JWT (без стирания): dave то же, затем erin — carol ничего не получает, журнал erin
#      пустой, файлы dave унесены в его каталог (tdata/parvane-v2-dave@local/account-files), в tdata их нет.
# Только выдуманные адреса и тексты.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="${SCRATCH:-$(mktemp -d /tmp/pv-relogin.XXXXXX)}"
stack_start "$SB"
C="$SB/carol"; W="$SB/shared"; W2="$SB/shared2"
SEED="PARVANE_AUTOSEED=carol@local:30"

# Строки лога после входа указанного аккаунта (лог процесса общий; выход со стиранием его обрезает)
after_login() { # after_login <log> <адрес>
  awk -v a="сессия поднята для $2" 'index($0, a) { s = 1 } s' "$1" 2>/dev/null
}

# carol ↔ alice и carol ↔ dave: ключи доступа, отложенное было бы доставлено
pair_exchange "$W" alice@local "$C" carol@local
pair_exchange "$W2" dave@local "$C" carol@local

CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$C/td/log.txt" "v2: готов" 90 && ok "carol на связи" || bad "carol не поднялась"

# ── 1) выход со стиранием → вход bob в том же процессе ──
P=$(start_client "$W" alice@local PARVANE_NO_LINK_OFFER=1 "$SEED" PARVANE_AUTOLOGOUT=wipe@15 \
  "PARVANE_AUTOLOGIN_NEXT=bob@local:$PV_PASSWORD")
wait_log "$W/td/log.txt" "autoseed → черновик и отложенное для carol@local" 60 \
  && ok "alice: черновик и отложенное carol поставлены" || bad "alice: хук autoseed не сработал"
wait_log "$W/td/log.txt" "сессия поднята для bob@local" 120 && ok "bob вошёл в том же процессе" || bad "bob не вошёл"
kill -0 "$P" 2>/dev/null && ok "процесс тот же (не перезапускался)" || bad "процесс завершился"
wait_log "$W/td/log.txt" "v2: готов" 90 || bad "bob: устройство v2 не готово"
wait_log "$W/td/log.txt" "журнал состояния — подключение" 60 || true
JB=$(after_login "$W/td/log.txt" bob@local)
echo "$JB" | grep -aqE "журнал состояния — подключение \(черновиков 0, отложенных 0\)" \
  && ok "журнал состояния bob подключён без черновиков и отложенных alice" \
  || bad "журнал состояния bob несёт черновики/отложенные (или не подключился)"
sleep 25 # срок отложенного alice (+30 с) прошёл
JB=$(after_login "$W/td/log.txt" bob@local)
echo "$JB" | grep -aq "запланированное отправлено" && bad "отложенное alice отправлено после выхода" \
  || ok "отложенное alice после выхода не отправлено"
grep -aqE "входящее msg .*\(bob@local\)" "$C/td/log.txt" && bad "carol получила сообщение от bob" \
  || ok "carol от bob ничего не получила"
grep -aq "отложенное-прежнего-аккаунта" "$C/td/log.txt" && bad "carol получила отложенное alice" \
  || ok "carol отложенное alice не получила"
[ ! -e "$W/td/tdata/parvane-v2-alice@local" ] && [ ! -e "$W/td/tdata/parvane-history-alice@local.jsonl" ] \
  && ok "в tdata нет каталога состояния и журнала истории alice" || bad "данные alice остались в tdata"
[ ! -e "$W/td/tdata/parvane-scheduled.json" ] && ok "очереди отложенных в tdata нет (bob ничего не планировал)" \
  || bad "в tdata очередь отложенных"
echo "$JB" | grep -aq "прежнего-аккаунта" && bad "в журнале bob строки с данными alice" || ok "в журнале bob данных alice нет"
stop_pid "$P"

# ── 2) выход как при отказе JWT (без стирания) → вход erin в том же процессе ──
P=$(start_client "$W2" dave@local PARVANE_NO_LINK_OFFER=1 "$SEED" PARVANE_AUTOLOGOUT=reject@15 \
  "PARVANE_AUTOLOGIN_NEXT=erin@local:$PV_PASSWORD")
wait_log "$W2/td/log.txt" "autoseed → черновик и отложенное для carol@local" 60 \
  && ok "dave: черновик и отложенное carol поставлены" || bad "dave: хук autoseed не сработал"
wait_log "$W2/td/log.txt" "autologout → reject" 40 || bad "dave: хук autologout не сработал"
wait_log "$W2/td/log.txt" "состояние аккаунта в памяти сброшено \(выход без стирания\)" 30 \
  && ok "выход без стирания: память dave сброшена" || bad "память dave не сброшена"
wait_log "$W2/td/log.txt" "сессия поднята для erin@local" 120 && ok "erin вошла в том же процессе" || bad "erin не вошла"
kill -0 "$P" 2>/dev/null && ok "процесс тот же (не перезапускался)" || bad "процесс завершился"
wait_log "$W2/td/log.txt" "файлы аккаунта: прежнего \(dave@local\) унесено [1-9]" 10 \
  && ok "файлы dave унесены в его каталог" || bad "файлы dave не унесены"
F="$W2/td/tdata/parvane-v2-dave@local/account-files/parvane-scheduled.json"
[ -s "$F" ] && ok "очередь отложенных dave — в его каталоге" || bad "нет $F"
grep -aq "^PVSE1" "$F" 2>/dev/null && ok "файл dave зашифрован" || bad "файл dave не зашифрован"
[ ! -e "$W2/td/tdata/parvane-scheduled.json" ] && [ ! -e "$W2/td/tdata/parvane-drafts.json" ] \
  && ok "в tdata нет отложенных и черновиков dave" || bad "erin видит файлы dave в tdata"
wait_log "$W2/td/log.txt" "v2: готов" 90 || bad "erin: устройство v2 не готово"
sleep 5
JE=$(after_login "$W2/td/log.txt" erin@local)
echo "$JE" | grep -aqE "журнал состояния — подключение \(черновиков 0, отложенных 0\)" \
  && ok "журнал состояния erin подключён без черновиков и отложенных dave" \
  || bad "журнал состояния erin несёт черновики/отложенные (или не подключился)"
sleep 25
JE=$(after_login "$W2/td/log.txt" erin@local)
echo "$JE" | grep -aq "запланированное отправлено" && bad "отложенное dave отправлено после выхода" \
  || ok "отложенное dave после выхода не отправлено"
grep -aqE "входящее msg .*\(erin@local\)" "$C/td/log.txt" && bad "carol получила сообщение от erin" \
  || ok "carol от erin ничего не получила"
grep -aq "отложенное-прежнего-аккаунта" "$C/td/log.txt" && bad "carol получила отложенное dave" \
  || ok "carol отложенное dave не получила"
stop_pid "$P"
stop_pid "$CP"

grep -aqiE "Fatal|Unexpected in " "$W/td/"log*.txt "$W2/td/"log*.txt && bad "фатальные ошибки" || ok "без фатальных ошибок"
stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "ИЗОЛЯЦИЯ АККАУНТОВ: ВХОД ДРУГИМ В ТОМ ЖЕ ПРОЦЕССЕ"
