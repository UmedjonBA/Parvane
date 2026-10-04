#!/usr/bin/env bash
# Протокол v2 (spec 007, T134/T169, FR-056 — этап E6): сервер с ОТКЛЮЧЁННЫМ v1
# (gateway PARVANE_V1_MODE=disabled). JSON-соединение v1 получает
# `upgrade_required` и закрывается, поэтому всё, что клиент делает, идёт
# методами v2: регистрация и вход, профиль, сообщение, файл, группа v2 и её фото,
# звонок, линковка второго устройства, список устройств. Клиент при этом НЕ показывает «обновите
# приложение» — он работоспособен.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-v1off"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed PARVANE_V1_MODE=disabled" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"
BIO="био-без-v1-$S"

# ── регистрация и вход по v2 ─────────────────────────────────────────────────
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "login OK for bob@local" 60 && ok "bob: регистрация и вход по v2" || bad "bob не вошёл"
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
# режим gateway пишет в лог при первом v1-соединении (его открывает и тут же теряет клиент)
wait_log "$SB/gateway.log" "v1-путь в режиме Disabled" 30 && ok "gateway: v1 отключён (PARVANE_V1_MODE=disabled)" \
  || bad "gateway не в режиме disabled"
wait_log "$BL" "соединения v1 нет .* все запросы идут по v2" 30 && ok "bob: соединения v1 нет, клиент работает по v2" \
  || bad "bob: нет отметки о работе без v1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOSEND_V2=bob@local:без-v1-$S" "PARVANE_AUTOPROFILE=bio=$BIO:8")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова" || bad "alice1: v2 не поднялся"

# ── сообщение и профиль ──────────────────────────────────────────────────────
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): без-v1-$S" 60 && ok "bob получил сообщение alice" \
  || bad "bob не получил сообщение alice"
wait_log "$L1" "autoprofile применён" 60 && ok "alice1: профиль сохранён методом v2" || bad "alice1: профиль не сохранён"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:ответ-без-v1-$S")
wait_log "$BL" "профиль alice@local: bio=$BIO" 60 && ok "bob видит профиль alice (identity.profile.resolve)" \
  || bad "bob не видит профиль alice"
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): ответ-без-v1-$S" 60 && ok "alice получила ответ bob" \
  || bad "alice не получила ответ bob"

# ── файл: блоб по capability, v1-гранты не нужны ─────────────────────────────
SRC="$SB/файл-$S.bin"; head -c 70000 /dev/urandom > "$SRC"
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOSENDFILE=bob@local:$SRC")
wait_log "$L1" "Parvane: медиа отправлено" 90 && ok "alice отправила файл" || bad "alice не отправила файл"
wait_log "$BL" "получено медиа alice@local: .* \(70000 байт\)" 60 && ok "bob получил и расшифровал файл (70000 байт)" \
  || bad "bob не получил файл"

# ── группа v2 и её фото: сведения — журналом группы, фото — открытым блобом ───
G="Без-v1-$S"
PNG="$SB/group.png"
python3 - "$PNG" <<'PYEOF'
import struct, sys, zlib
w = h = 64
raw = b''.join(b'\x00' + bytes([42, 171, 238]) * w for _ in range(h))
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
PYEOF
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOGROUP=$G:bob@local" \
  "PARVANE_AUTOGROUPSEND=$G:группа-без-v1-$S")
wait_log "$L1" "группа v2 '$G' создана: v2g:[0-9a-f]{32}" 60 && ok "alice создала группу v2" || bad "группа v2 не создана"
GID=$(grep -oE "группа v2 '$G' создана: v2g:[0-9a-f]{32}" "$L1" | grep -oE 'v2g:[0-9a-f]{32}' | head -1)
wait_log "$BL" "v2: группа $GID появилась" 60 && ok "bob: группа из журнала ($GID)" || bad "bob: группа v2 не появилась"
wait_log "$BL" "групповое [0-9a-f-]+ в $GID от alice@local: группа-без-v1-$S" 60 && ok "bob прочитал групповое alice" \
  || bad "bob не прочитал групповое"
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOGROUPINFO=$G:avatar=$PNG")
wait_log "$L1" "AUTOGROUPINFO '$G' avatar → ok" 60 && ok "alice поставила фото группы (открытый блоб по v2)" \
  || bad "фото группы не принято"
wait_log "$BL" "группа $GID обновлена .* avatar=[0-9a-f-]{36}" 60 && ok "bob получил фото группы" \
  || bad "фото группы не дошло до bob"

# ── звонок: сигналы запечатанными конвертами, шард call по v1 не участвует ────
stop_pid "$PB"; stop_pid "$P1"
PB=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOACCEPT=1)
sleep 8
P1=$(start_client "$A1" alice@local PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOCALL=bob@local")
wait_log "$BL" "ВХОДЯЩИЙ звонок от alice@local" 60 && ok "bob получил входящий звонок" || bad "bob не получил звонок"
wait_log "$L1" "звонок → Active" 40 && ok "alice: звонок соединён" || bad "alice не дошла до Active"
wait_log "$BL" "звонок → Active" 40 && ok "bob: звонок соединён" || bad "bob не дошёл до Active"

# ── второе устройство: линковка методами v2 ──────────────────────────────────
P2=$(start_client "$A2" alice@local PARVANE_AUTOLINK_GRANT=1)
wait_linked "$L2" 150 && ok "alice2 привязана грантом (identity.link.* по v2)" || bad "alice2 не привязана"
wait_log "$L2" "своё msg [0-9a-f-]+ \(bob@local\): без-v1-$S" 60 && ok "alice2: история v2 перенесена при линковке" \
  || bad "alice2: истории нет"

# ── устройства: список из журнала v2 ─────────────────────────────────────────
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_AUTOREVOKE_OTHERS=12)
wait_log "$L1" "устройство .* \[текущее\]" 60 && ok "alice1 видит себя в списке устройств" || bad "список устройств пуст"
wait_log "$L1" "autorevoke .* → ok" 60 && ok "alice1 отозвала alice2 (reauth + identity.device.revoke)" \
  || bad "отзыв устройства не удался"

# ── v1 действительно не использовался ────────────────────────────────────────
grep -qa "gateway::session.*Клиент авторизован" "$SB/gateway.log" && bad "кто-то авторизовался по v1" \
  || ok "по v1 не авторизовался никто"
[ "$(sqlite3 "$SB/messenger.db" "SELECT COUNT(*) FROM messages;")" = "0" ] && ok "в таблице сообщений v1 пусто" \
  || bad "в таблице v1 есть сообщения"
grep -qa "upgrade_required. — нужна новая версия" "$L1" "$L2" "$BL" && bad "клиент показал «обновите приложение»" \
  || ok "диалога «обновите приложение» нет"
if grep -qE "запись не открыта|ошибка записи|E2E не удался" "$L1" "$L2" "$BL"; then
  bad "в логах есть сбои записей v2"
else
  ok "сбоев записей v2 нет"
fi
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_v1off"
