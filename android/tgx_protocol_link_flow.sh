#!/usr/bin/env bash
# Привязка устройства LINK-1 (spec 031) — X в обеих ролях, свой стек.
#   A) X — НОВОЕ устройство alice: alice-desktop (первое устройство, грант без UI) выдаёт грант, X вступает в журнал
#      устройств, получает историю v2 (LINK-1 п. 8), группу и журнал личного состояния; bob пишет — читают оба.
#   B) X — СТАРОЕ устройство: второе desktop-устройство alice просит привязку, X подтверждает (хук = кнопка
#      «Привязать» экрана устройств), desktop вступает в журнал и получает историю.
#   ./tgx_protocol_link_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-proto-link}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"; S=$(date +%s)
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"; stack_start "$SB"; echo "STACK_SB=$SB"
A="$SB/alice"; A2="$SB/alice2"; B="$SB/bob"; AL="$A/td/log.txt"; A2L="$A2/td/log.txt"; BL="$B/td/log.txt"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
stop_pid "$BP"
G="ГруппаX$S"
AP=$(start_client "$A" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOGROUP=$G:bob@local")
wait_log "$AL" "v2: готов" 90 && ok "alice-desktop: первое устройство готово" || bad "alice-desktop: v2 не поднялся"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:до-привязки-$S")
wait_log "$AL" "входящее msg [0-9a-f-]+ \(bob@local\): до-привязки-$S" 90 && ok "alice-desktop получила текст bob" || bad "alice-desktop не получила текст bob"
wait_log "$AL" "группа v2 '$G' создана: v2g:[0-9a-f]{32}" 60 && ok "alice-desktop: группа создана" || bad "alice-desktop: группа не создана"
# A) X — новое устройство
emu_boot "$OUT" || { bad "эмулятор не загрузился"; finish "TGX PROTO LINK"; }
tgx_install
tgx_fresh alice@local
tgx_logwait "устройству нужна привязка" 90 && ok "X: аккаунт уже с журналом — нужна привязка" || bad "X: нет «нужна привязка»"
grep -aq "v2: устройство создано" "$TGX_LOG" && bad "X создал собственный корень" || ok "X: второй корень не создан"
tgx_logwait "привязка: оффер опубликован" 60 && ok "X опубликовал оффер" || bad "X без оффера"
wait_log "$AL" "линковка: грант v2 приложен" 120 && ok "alice-desktop приложила грант" || bad "alice-desktop не приложила грант"
tgx_logwait "привязка: грант v2 получен" 90 && ok "X получил грант" || bad "X не получил грант"
tgx_logwait "история v2 перенесена \([1-9][0-9]* сообщений\)" 60 && ok "X получил историю (LINK-1 п. 8)" || bad "X: история не перенесена"
tgx_logwait "устройство привязано грантом линковки" 60 && ok "X записан в журнал устройств" || bad "X не вступил в журнал"
tgx_logwait "v2: готов" 90 && ok "X: сессия v2 готова" || bad "X: v2 не поднялся"
tgx_logwait "группа v2 v2g:[0-9a-f]{32} (появилась|обновлена)" 90 && ok "X: группа аккаунта появилась" || bad "X: группа не появилась"
tgx_logwait "журнал личного состояния подключён" 60 && ok "X: журнал личного состояния подключён" || bad "X: журнал состояния не подключён"
wait_log "$AL" "v2: новое своё устройство" 60 && ok "alice-desktop увидела новое своё устройство" || bad "alice-desktop не увидела новое устройство"
sleep 32 # messenger кэширует устройства получателя 30 с
stop_pid "$BP"; tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:после-привязки-$S")
wait_log "$AL" "входящее msg [0-9a-f-]+ \(bob@local\): после-привязки-$S" 60 && ok "alice-desktop прочитала" || bad "alice-desktop не прочитала"
tgx_logwait "v2 ← входящее msg" 90 && ok "X (новое устройство) принял текст bob" || bad "X не принял текст после привязки"
stop_pid "$BP"; stop_pid "$AP"
# B) X — старое устройство: alice2 (desktop, новый каталог) просит привязку
tgx_mark
A2P=$(start_client "$A2" alice@local)
tgx_logwait "привязка: запрос от нового устройства" 120 && ok "X: запрос привязки от нового устройства (код сверки)" || bad "X: запроса привязки нет"
tgx_cmd '{"op":"link_grant","peer":"alice@local"}' && ok "X подтвердил привязку" || bad "X не подтвердил"
tgx_logwait "привязка: грант выдан" 60 && ok "X выдал грант" || bad "X не выдал грант"
wait_log "$A2L" "устройство привязано грантом линковки" 90 && ok "alice2 (desktop) вступила в журнал устройств" || bad "alice2 не вступила"
wait_log "$A2L" "v2: готов" 60 && ok "alice2: v2 готов" || bad "alice2: v2 не поднялся"
stop_pid "$A2P"
tgx_no_crash
grep -aqE "запись не открыта|E2E не удался" "$TGX_LOG" "$AL" "$BL" && bad "сбои записей v2 в логах" || ok "сбоев записей v2 нет"
kill "$TGX_LCP" 2>/dev/null
finish "TGX PROTO LINK"
