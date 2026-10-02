#!/usr/bin/env bash
# Parvane — e2e групп в форке на ПРЯМОМ NATS (dev-транспорт, без gateway):
# alice создаёт группу с bob, bob (участник) авто-подхватывает её (RefreshGroups
# → синтез чата), затем групповое сообщение alice (Megolm, хук
# PARVANE_AUTOGROUPSEND — штатный путь отправки) доставляется bob и инъецируется
# в чат группы. То же через gateway — verify_group_e2e.sh. Стек поднимает сам.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
RC=0
ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }
# стек поднимаем сами (раньше скрипт ждал вручную запущенные nats+шарды)
STACK="$(mktemp -d /tmp/parvane-group-stack.XXXXXX)"; stack_up "$STACK"

ALICE=$(mktemp -d /tmp/pv-vgrp-alice.XXXXXX); BOB=$(mktemp -d /tmp/pv-vgrp-bob.XXXXXX)
AL="$ALICE/td/log.txt"; BL="$BOB/td/log.txt"
TEXT="привет группе $(date +%s)"
# bob первым: его prekeys должны быть в каталоге до раздачи ключа группы (SKDM)
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" \
  "$BIN" -workdir "$BOB/td" >"$BOB/out.log" 2>&1 &
BP=$!
wait_log "$BL" "E2E-устройство готово" 40 || bad "bob не поднялся"
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" \
  PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" PARVANE_AUTOGROUP='ГруппаТест:bob@local' \
  PARVANE_AUTOGROUPSEND="ГруппаТест:$TEXT" \
  "$BIN" -workdir "$ALICE/td" >"$ALICE/out.log" 2>&1 &
AP=$!
wait_log "$AL" "группа .* создана" 40
GID=$(grep -a 'группа .* создана' "$AL" 2>/dev/null | head -1 | grep -oE '[0-9a-f-]{36}' | head -1)
wait_log "$BL" "группа синтезирована $GID" 40
wait_log "$BL" "групповое .* от alice@local: $TEXT" 60

[ -n "$GID" ] && ok "alice создала группу ($GID)" || bad "группа не создана"
grep -qa "группа синтезирована $GID" "$AL" && ok "alice синтезировала чат группы" || bad "alice не синтезировала"
grep -qa "группа синтезирована $GID" "$BL" && ok "bob авто-подхватил и синтезировал группу" || bad "bob не подхватил группу"
grep -qa "групповое .* от alice@local: $TEXT" "$BL" && ok "групповое сообщение доставлено и инъецировано bob" || bad "групповое сообщение не дошло"

kill -9 "$AP" "$BP" 2>/dev/null
grep -qiE "Fatal|Unexpected in " "$AL" "$BL" && bad "фатальная ошибка в логе" || ok "без фатальных ошибок"
if [ "$RC" -eq 0 ]; then printf '\033[32mГРУППЫ e2e: ВСЁ ОК\033[0m\n'; else printf '\033[31mГРУППЫ e2e: ПРОВАЛЫ\033[0m\n'; fi
stack_stop
exit $RC
