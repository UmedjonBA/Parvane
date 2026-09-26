#!/usr/bin/env bash
# Группы, spec 004 в форке X (эмулятор): GROUP-1 (нотисы применяются без перезапуска)
# и GROUP-2 (приёмный фильтр прав по типу содержимого) на стороне X.
# Запускать ПОСЛЕ tgx_link_e2e.sh: стек в последнем /tmp/pv-tgx.*, alice-десктоп
# (первое устройство) жив, X — второе устройство alice после линковки.
#   1. alice-десктоп создаёт группу с bob → X видит группу (синк по нотису/списку);
#   2. alice снимает send_media (AUTOGROUPPERMS) → X: «группа <gid>: perms v1»
#      и «→ X UpdateChatPermissions» (GROUP-1, экран «Permissions» перерисован);
#   3. bob (участник без права) шлёт фото В ОБХОД композера → X: «скрыто правами
#      группы», сообщение в чат не попало (GROUP-2);
#   4. alice создаёт ссылку, carol вступает по ней → X: «группа <gid>: members»
#      (GROUP-1, список участников обновлён без перезапуска);
#   5. alice возвращает send_media → bob шлёт фото штатно → X показал.
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
. "$(dirname "${BASH_SOURCE[0]}")/../desktop/verify_lib.sh"
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -qE \"$1\"; do sleep 3; done"; }
OUT=/tmp/pv-tgx-group-manage; mkdir -p "$OUT"
SB=$(\ls -td /tmp/pv-tgx.* | head -1); STAMP=$(date +%s); GNAME="pvmanage-$STAMP"
A="$SB/alice"; B="$SB/bob"; C="$SB/carol"; mkdir -p "$C/td"
PNG="$OUT/photo.png"
python3 - "$PNG" <<'EOF'
import struct, sys, zlib
w = h = 48
raw = b''.join(b'\x00' + bytes([200, 60, 60]) * w for _ in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
EOF
[ "$(ad shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && ok "эмулятор жив" || { bad "эмулятора нет — сначала tgx_link_e2e.sh"; finish "TGX GROUP MANAGE"; }
ad logcat -c

# 1. группа
kill $(pgrep -f "workdir $SB/alice/t[d]") 2>/dev/null; sleep 2
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUP="$GNAME:bob@local")
wait_log "$A/td/log.txt" "группа '$GNAME' создана" 60 && ok "alice создала группу" || bad "группа не создана"
GID=$(grep -a "группа '$GNAME' создана" "$A/td/log.txt" | grep -oE '[0-9a-f-]{36}' | head -1); echo "GID=$GID"
# На создание нотиса нет: второе устройство узнаёт о группе по первому событию
# в ней (сообщение или нотис {group}) — как web refreshGroupsIfUnknownChat и
# X «группа завелась на другом устройстве». Проверяется на шаге 2 (нотис perms).
# bob: прогрев синка групп (хук отправки в группу нужен со второго запуска)
kill $(pgrep -f "workdir $SB/bob/t[d]") 2>/dev/null; sleep 2
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "группа $GID обновлена \(v0, список\)" 60 && ok "bob знает группу" || bad "bob не синхронизировал группу"

# 2. GROUP-1: права по умолчанию нотисом
stop_pid "$AP"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:send_media=0")
wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 && ok "alice сняла send_media" || bad "send_media не снят"
xlog "группа $GID: perms v1" 60 && ok "GROUP-1 (X): нотис perms v1 принят (группа появилась по нотису)" || bad "GROUP-1 (X): нотис perms не пришёл"
xlog "→ X UpdateChatPermissions" 30 && ok "GROUP-1 (X): UpdateChatPermissions ушёл в UI" || bad "GROUP-1 (X): UpdateChatPermissions не отправлен"
wait_log "$B/td/log.txt" "группа $GID обновлена \(v1, нотис\)" 40 || bad "bob не получил права"

# 3. GROUP-2: bob без права шлёт фото в обход → X скрыл
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSENDFILE="$GNAME:$PNG;bypass=1")
wait_log "$B/td/log.txt" "AUTOGROUPSENDFILE → отправлено" 40 && ok "bob отправил фото в обход" || bad "bob не отправил"
xlog "групповое [0-9a-f-]{36} \((file|photo)\) от bob@local скрыто правами группы" 90 \
  && ok "GROUP-2 (X): фото участника без права скрыто" || bad "GROUP-2 (X): фото не скрыто"
HIDDEN=$(adb logcat -d 2>/dev/null | grep -aoE "групповое [0-9a-f-]{36} \((file|photo)\) от bob@local скрыто" | grep -oE '[0-9a-f-]{36}' | head -1)
[ -n "$HIDDEN" ] && { adb logcat -d 2>/dev/null | grep -aq "сообщение $HIDDEN → чат" && bad "GROUP-2 (X): скрытое всё же попало в чат" || ok "GROUP-2 (X): скрытое в чат не попало"; }
# маленький PNG уходит документом (kind=file) — фильтр по типу его тоже прячет; логи alice ротируются на каждый старт
timeout 60 bash -c "until grep -aqE 'групповое $HIDDEN \((file|photo)\) от bob@local скрыто правами группы' $A/td/log*.txt; do sleep 2; done" \
  && ok "GROUP-2 (десктоп alice): то же сообщение скрыто" || bad "GROUP-2 (десктоп alice): не скрыто"

# 4. GROUP-1: вступление по ссылке → members
stop_pid "$AP"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPINVITE="$GNAME:create")
wait_log "$A/td/log.txt" "AUTOGROUPINVITE '$GNAME' create → ok" 40 && ok "alice создала ссылку" || bad "ссылка не создана"
TOK=$(grep -a "AUTOGROUPINVITE '$GNAME' create → ok" "$A/td/log.txt" | tail -1 | grep -oE 'ok [0-9a-f]{32}' | cut -d' ' -f2)
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1)
wait_log "$C/td/log.txt" "E2E-устройство готово" 60 || bad "carol не поднялась"
stop_pid "$CP"
CP=$(start_client "$C" carol@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPJOIN="https://parvane.invite/$TOK")
wait_log "$C/td/log.txt" "AUTOGROUPJOIN join → ok $GID" 40 && ok "carol вступила по ссылке" || bad "carol не вступила"
xlog "группа $GID: members v" 60 && ok "GROUP-1 (X): нотис members принят (carol в списке)" || bad "GROUP-1 (X): нотис members не пришёл"
xlog "→ X UpdateBasicGroupFullInfo" 30 && ok "GROUP-1 (X): список участников перерисован" || bad "GROUP-1 (X): UpdateBasicGroupFullInfo не отправлен"

# 5. право возвращено → фото bob показано
stop_pid "$AP"
AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPPERMS="$GNAME:send_media=1")
wait_log "$A/td/log.txt" "AUTOGROUPPERMS '$GNAME' → ok" 40 && ok "send_media возвращён" || bad "send_media не возвращён"
wait_log "$B/td/log.txt" "\"send_media\":true" 40 || bad "bob не получил возврат права"
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOGROUPSENDFILE="$GNAME:$PNG")
wait_log "$B/td/log.txt" "AUTOGROUPSENDFILE → отправлено" 40 && ok "bob отправил фото штатно" || bad "bob не отправил штатно"
xlog "сообщение [0-9a-f-]{36} → чат -[0-9]+ \(вх\)" 90 && ok "GROUP-2 (X): фото с правом показано" || bad "GROUP-2 (X): фото с правом не показано"

sleep 3; ad exec-out screencap -p > "$OUT/01-list.png"
ad logcat -d -v time > "$OUT/logcat.txt"
grep -q "AndroidRuntime" "$OUT/logcat.txt" && bad "краш (AndroidRuntime)" || ok "X без крашей"
stop_pid "$BP"; stop_pid "$CP"
echo "GROUP_MANAGE_E2E_DONE rc=$RC"
finish "TGX GROUP MANAGE"
