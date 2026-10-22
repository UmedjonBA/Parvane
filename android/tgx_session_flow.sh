#!/usr/bin/env bash
# Форк Telegram X в эмуляторе на локальном стеке v2 (spec 031): bob — desktop, alice — X (вход dev-хуком
# debug-сборки: аккаунт заводится сам), переписка в обе стороны. Стек и эмулятор остаются для следующих сценариев
# (каталог стека — `ls -td /tmp/pv-tgx.* | head -1`, его печатает строка STACK_SB=).
#   ./tgx_session_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # verify_lib переопределяет ROOT на desktop/
OUT="${1:-/tmp/pv-tgx-session}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"; stack_start "$SB"; echo "STACK_SB=$SB"
B="$SB/bob"; BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "v2: готов" 90 && ok "bob (desktop) на v2" || bad "bob не поднялся"
emu_boot "$OUT" && ok "эмулятор" || { bad "эмулятор не загрузился"; finish "TGX SESSION"; }
tgx_install && ok "APK установлен" || bad "APK не установился"
tgx_fresh alice@local
tgx_logwait "autologin \(dev\): вход alice@local" 40 && ok "вход dev-хуком" || bad "dev-хук входа не сработал"
tgx_logwait "v2: готов" 120 && ok "alice (X) на v2: устройство в журнале" || bad "сессия v2 X не поднялась"
sleep 5; tgx_shot "$OUT/01-main.png"
# bob → alice
S="privet-$(date +%s)"; tgx_mark
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:$S")
tgx_logwait "v2 ← входящее msg" 90 && ok "X получил сообщение bob" || bad "X не получил сообщение bob"
tgx_logwait "сообщение .* → чат .* \(вх\)" 20 && ok "сообщение в чате X" || bad "сообщение не дошло до UI X"
# alice → bob (хук шва: тот же путь, что поле ввода X)
tgx_cmd "{\"op\":\"send\",\"peer\":\"bob@local\",\"text\":\"otvet-$S\"}" && ok "X отправил ответ" || bad "команда отправки не выполнилась"
wait_log "$B/td/log.txt" "входящее msg .*alice@local.*otvet-$S" 60 && ok "bob получил ответ X" || bad "bob не получил ответ X"
sleep 3; tgx_shot "$OUT/02-chat.png"
tgx_no_crash
grep -oE "не реализовано: [A-Za-z]+" "$TGX_LOG" | sort | uniq -c | sort -rn > "$OUT/unimplemented.txt"
echo "не реализовано (топ): $(head -12 "$OUT/unimplemented.txt" | awk '{print $NF"("$1")"}' | tr '\n' ' ')"
stop_pid "$BP"
kill "$TGX_LCP" 2>/dev/null
finish "TGX SESSION"
