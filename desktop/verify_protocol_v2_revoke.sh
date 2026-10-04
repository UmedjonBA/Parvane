#!/usr/bin/env bash
# Протокол v2 (spec 007, T128, FR-066; правило REVOKE-1): отзыв своего
# устройства на десктопе.
# alice1 — первое v2-устройство (корень лежит у неё), alice2 привязана грантом
# LINK-1 v2, bob — собеседник на v2. alice1 отзывает alice2 (хук
# PARVANE_AUTOREVOKE_OTHERS): список устройств показывает alice2 из журнала v2
# (в каталог v1 она не попадает), после v1-отзыва в журнал устройств уходит
# запись отзыва, меняются ключ доступа к доставке и ключ личного состояния
# (журнал состояния переносится под новый ключ — папка на месте), SSK меняется
# корнем сразу. Новое сообщение bob читает alice1 и не читает alice2.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-revoke"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"

PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1 \
  "PARVANE_AUTOSEND_V2=bob@local:до-отзыва-$S" "PARVANE_AUTOFOLDER=Работа-$S:bob@local")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова (первое устройство)" || bad "alice1: v2 не поднялся"
wait_log "$L1" "журнал личного состояния подключён" 60 && ok "alice1: журнал личного состояния подключён" \
  || bad "alice1: журнал состояния не подключён"
wait_log "$L1" "AUTOFOLDER создал папку 'Работа-$S'" 90 && ok "alice1: папка создана" || bad "alice1: папка не создана"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): до-отзыва-$S" 60 && ok "bob получил текст alice1 по v2" \
  || bad "bob не получил текст alice1"

# ── второе устройство: линковка грантом ──────────────────────────────────────
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1)
wait_log "$L2" "v2: устройство привязано грантом линковки" 150 && ok "alice2 записана в журнал устройств" \
  || bad "alice2 не вступила в журнал устройств"
wait_log "$L2" "v2: готов" 90 && ok "alice2: v2-сессия готова" || bad "alice2: v2 не поднялся"
wait_log "$L1" "v2: новое своё устройство" 60 && ok "alice1 увидела новое своё устройство" \
  || bad "alice1 не увидела новое устройство"
N=$(sqlite3 "$SB/identity.db" "SELECT COUNT(*) FROM device_keys WHERE username='alice@local';")
# До привязки v1-бандл нового устройства identity отвергает (T048); после привязки
# к журналу v2 устройство вправе досдать бандл (T146) — успело или нет, решает гонка.
# без v1 (PV_V1_OFF) v1-бандлы не публикуются вовсе — каталог v1 пуст
{ [ "$N" = "1" ] || [ "$N" = "2" ] || { v1_off && [ "$N" = "0" ]; }; } && ok "каталог v1 alice: устройств $N (привязанное досдаёт бандл после линковки, T146)" \
  || bad "device_keys alice: $N"

# ── alice1 отзывает alice2 ───────────────────────────────────────────────────
stop_pid "$P1"
: > "$L1.before-revoke"; cp "$L1" "$L1.before-revoke" 2>/dev/null
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOREVOKE_OTHERS=12)
wait_log "$L1" "v2: готов" 90 && ok "alice1 поднята заново" || bad "alice1 не поднялась"
wait_log "$L1" "устройство .* \[текущее\]" 60 && ok "alice1 видит себя в списке устройств" || bad "список устройств пуст"
[ "$(grep -cE 'Parvane: устройство [0-9a-zA-Z_-]+ \(otk=' "$L1")" -ge 1 ] \
  && ok "в списке есть второе устройство (из журнала v2)" || bad "второго устройства в списке нет"
wait_log "$L1" "autorevoke .* → ok" 60 && ok "alice1 отозвала alice2 (v1: пароль, тумбстоун)" || bad "v1-отзыв не удался"
wait_log "$L1" "v2: устройство отозвано \(ротаций [1-9]" 60 && ok "запись отзыва в журнале v2 + ротации ключей" \
  || bad "отзыв в журнале v2 не выполнен"
wait_log "$L1" "v2: SSK сменён корнем" 60 && ok "SSK сменён корнем (корень на первом устройстве)" || bad "SSK не сменён"
wait_log "$L1" "v2: журнал состояния перенесён под новый ключ \([1-9]" 60 \
  && ok "журнал личного состояния перенесён под новый ключ" || bad "журнал состояния не перенесён"
REV=$(sqlite3 "$SB/identity.db-v2.db" "SELECT COUNT(*) FROM device_state WHERE user='alice@local' AND revoked=1;" 2>/dev/null)
[ "$REV" = "1" ] && ok "сервер: одно отозванное устройство в журнале alice" || bad "device_state revoked: ${REV:-нет БД}"

# ── после отзыва: читает только живое устройство ─────────────────────────────
sleep 17 # bob перечитывает журнал alice раз в 15 с
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:после-отзыва-$S")
wait_log "$BL" "v2 → alice@local msg [0-9a-f-]+ \(text\)" 90 && ok "bob → alice ушло по v2" || bad "bob → alice не ушло по v2"
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): после-отзыва-$S" 60 && ok "alice1 читает после отзыва" \
  || bad "alice1 не прочитала"
sleep 5
grep -q "входящее msg .* (bob@local): после-отзыва-$S" "$L2" && bad "отозванная alice2 прочитала новое сообщение" \
  || ok "отозванная alice2 новое сообщение НЕ читает"

if grep -qE "ошибка записи|E2E не удался|отзыв устройства в журнале не выполнен|смена SSK не удалась" "$L1" "$BL"; then
  bad "в логах есть сбои v2"
else
  ok "сбоев v2 нет"
fi
grep -qiE "Fatal|Unexpected in " "$L1" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_revoke"
