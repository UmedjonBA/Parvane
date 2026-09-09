#!/usr/bin/env bash
# Parvane — уведомления и профильные поля кросс-девайс (десктоп ↔ десктоп):
#   1) alice(dev1) создаёт группу с bob, ставит bio/телефон/цвет имени/личный
#      канал (PARVANE_AUTOPROFILE) и мутит bob и группу (PARVANE_AUTOMUTE);
#   2) alice(dev2) — второе устройство того же аккаунта — получает блоб
#      уведомлений из sync (notify_settings): bob и группа замучены навсегда;
#   3) bob резолвит alice через identity и видит bio/телефон/цвет/личный канал
#      (personal_channel = group_id группы, в которой он состоит).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/verify_lib.sh"
SB="${SCRATCH:-$(mktemp -d /tmp/pv-notify.XXXXXX)}"
stack_start "$SB"
STAMP="$(date +%s)"
GNAME="np-group-$STAMP"
BIO="bio-$STAMP"
PHONE="+7900$((STAMP % 1000000))"
PHONE_RE="${PHONE//+/\\+}" # «+» в регулярке wait_log
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"; mkdir -p "$A1/td" "$A2/td" "$B/td"

# bob регистрируется первым (alice добавляет его в группу по адресу)
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 40 || bad "bob: устройство не готово"
stop_pid "$BP"

# alice dev1: группа через ~4с, профиль через 8с, мут bob + группы через 11с
P1=$(start_client "$A1" alice@local PARVANE_NO_LINK_OFFER=1 \
  PARVANE_AUTOGROUP="$GNAME:bob@local" \
  PARVANE_AUTOPROFILE="bio=$BIO;phone=$PHONE;color=5;channel=$GNAME:8" \
  PARVANE_AUTOMUTE="bob@local,group:$GNAME:11")
wait_log "$A1/td/log.txt" "группа '$GNAME' создана" 40 && ok "alice создала группу" || bad "alice не создала группу"
GID=$(grep -a "группа '$GNAME' создана" "$A1/td/log.txt" | grep -oE '[0-9a-f-]{36}' | head -1)
wait_log "$A1/td/log.txt" "autoprofile применён" 40 && ok "alice: профиль отправлен" || bad "alice: autoprofile не сработал"
wait_log "$A1/td/log.txt" "профиль обновлён .*personal_channel" 20 && ok "alice: identity принял профиль с личным каналом" || bad "alice: identity не подтвердил профиль"
wait_log "$A1/td/log.txt" "automute → bob@local" 40 && ok "alice: bob замучен" || bad "alice: мут bob не сработал"
wait_log "$A1/td/log.txt" "automute → group:$GNAME" 20 && ok "alice: группа замучена" || bad "alice: мут группы не сработал"
sleep 2

# alice dev2: чистое второе устройство → sync отдаёт notify_settings
P2=$(start_client "$A2" alice@local PARVANE_NO_LINK_OFFER=1)
wait_log "$A2/td/log.txt" "уведомления с другого устройства: bob@local mutedUntil=2147483647" 60 \
  && ok "dev2: мут bob долетел (навсегда)" || bad "dev2: мут bob не долетел"
wait_log "$A2/td/log.txt" "уведомления с другого устройства: $GID mutedUntil=2147483647" 30 \
  && ok "dev2: мут группы долетел" || bad "dev2: мут группы не долетел"
wait_log "$A2/td/log.txt" "группа синтезирована $GID" 30 && ok "dev2: группа синтезирована (мут лёг на её чат)" || bad "dev2: группа не синтезирована"

# bob: резолв alice → профильные поля и личный канал
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:hi-$STAMP")
wait_log "$B/td/log.txt" "профиль alice@local: bio=$BIO phone=$PHONE_RE color=5 channel=$GID" 60 \
  && ok "bob видит bio/телефон/цвет/личный канал alice" || bad "bob не получил профиль alice ($(grep -a 'профиль alice@local' "$B/td/log.txt" | tail -1))"
wait_log "$A1/td/log.txt" "входящее msg .*bob@local.*hi-$STAMP" 40 && ok "переписка живая" || bad "alice не получила сообщение bob"

grep -qiE "Fatal|Unexpected in " "$A1/td/log.txt" "$A2/td/log.txt" "$B/td/log.txt" && bad "фатальные ошибки" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$BP"; stack_stop
[ "$RC" -eq 0 ] && rm -rf "$SB" || echo "логи: $SB"
finish "УВЕДОМЛЕНИЯ + ПРОФИЛЬ КРОСС-ДЕВАЙС"
