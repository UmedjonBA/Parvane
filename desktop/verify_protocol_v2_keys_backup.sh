#!/usr/bin/env bash
# Протокол v2 (spec 007, T152, FR-053): ручная копия ключей под паролем несёт
# историю v2-эпохи. alice1 переписывается с bob по v2 и сохраняет копию
# (PARVANE_AUTOKEYBACKUP=export). alice2 входит в аккаунт ключом восстановления
# (других устройств «нет» — линковки и её истории не будет): сервер v2 прошлые
# сообщения не отдаёт. После импорта копии (PARVANE_AUTOKEYBACKUP=import) alice2
# показывает переписку, а новое сообщение bob читает как обычное устройство.
# Устройство v2 из копии десктоп не перенимает (копия сливается), но кладёт его
# в файл — веб по такой копии становится тем же устройством.
# Бинарь tdesktop — с -DPARVANE_DEV=ON (хуки PARVANE_AUTO*).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-keys-backup"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A1="$SB/alice1"; A2="$SB/alice2"; B="$SB/bob"
L1="$A1/td/log.txt"; L2="$A2/td/log.txt"; BL="$B/td/log.txt"
KEY="$SB/alice1-recovery.key"; COPY="$SB/alice-keys.json"; PASS="Копия-$S"
rm -f "$KEY" "$COPY"

PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 "PARVANE_RECOVERY_KEY_FILE=$KEY" \
  "PARVANE_AUTOSEND_V2=bob@local:до-копии-$S")
wait_log "$L1" "v2: готов" 90 && ok "alice1: v2-сессия готова" || bad "alice1: v2 не поднялся"
wait_log "$L1" "v2: ключ восстановления записан в файл e2e" 30 && [ -s "$KEY" ] \
  && ok "alice1: ключ восстановления выдан" || bad "alice1: ключ восстановления не выдан"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): до-копии-$S" 60 && ok "bob получил текст alice1 по v2" \
  || bad "bob не получил текст alice1"
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:ответ-до-копии-$S")
wait_log "$L1" "входящее msg [0-9a-f-]+ \(bob@local\): ответ-до-копии-$S" 90 && ok "alice1 получила ответ bob по v2" \
  || bad "alice1 не получила ответ bob"

# ── копия ключей на alice1 ───────────────────────────────────────────────────
stop_pid "$P1"
P1=$(start_client "$A1" alice@local PARVANE_PROTO_V2=1 "PARVANE_RECOVERY_KEY_FILE=$KEY" \
  "PARVANE_AUTOKEYBACKUP=export:$PASS:$COPY")
wait_log "$L1" "AUTOKEYBACKUP export → ok" 90 && [ -s "$COPY" ] && ok "alice1: копия ключей сохранена" \
  || bad "alice1: копия ключей не сохранена"
grep -qE "копия ключей: история v2 \([2-9][0-9]* сообщений\)|копия ключей: история v2 \([1-9][0-9]+ сообщений\)" "$L1" \
  && ok "в копии — история v2 (обе стороны переписки)" || bad "истории v2 в копии нет"
grep -q "до-копии-$S" "$COPY" && bad "копия ключей лежит открытым текстом" || ok "копия зашифрована"
stop_pid "$P1"

# ── alice2: вход ключом восстановления — истории нет ─────────────────────────
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTORECOVER=$(cat "$KEY" 2>/dev/null)")
wait_log "$L2" "v2: autorecover → ok" 120 && ok "alice2 вошла ключом восстановления" || bad "alice2: вход по ключу не удался"
wait_log "$L2" "v2: готов" 90 && ok "alice2: v2-сессия готова" || bad "alice2: v2 не поднялся"
sleep 8
grep -q "до-копии-$S" "$L2" && bad "alice2 видит прошлую переписку без копии (сценарий ничего не проверяет)" \
  || ok "alice2: прошлой переписки нет (сервер v2 её не отдаёт)"

# ── импорт копии ─────────────────────────────────────────────────────────────
stop_pid "$P2"
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOKEYBACKUP=import:неверный-$S:$COPY")
wait_log "$L2" "AUTOKEYBACKUP import → отказ" 90 && ok "alice2: неверный пароль копии отвергнут" \
  || bad "alice2: неверный пароль не отвергнут"
stop_pid "$P2"
P2=$(start_client "$A2" alice@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOKEYBACKUP=import:$PASS:$COPY")
wait_log "$L2" "v2: готов" 90 && ok "alice2 поднята заново" || bad "alice2 не поднялась"
wait_log "$L2" "AUTOKEYBACKUP import → ok" 90 && ok "alice2: копия ключей принята" || bad "alice2: копия ключей не принята"
wait_log "$L2" "история v2 перенесена \([1-9][0-9]* сообщений\)" 60 && ok "alice2: история v2 из копии применена" \
  || bad "alice2: история v2 из копии не применена"
wait_log "$L2" "своё msg [0-9a-f-]+ \(bob@local\): до-копии-$S" 30 && ok "alice2 показывает своё сообщение из копии" \
  || bad "alice2: своего сообщения из копии нет"
wait_log "$L2" "входящее msg [0-9a-f-]+ \(bob@local\): ответ-до-копии-$S" 30 && ok "alice2 показывает ответ bob из копии" \
  || bad "alice2: ответа bob из копии нет"
[ "$(grep -cE "msg [0-9a-f-]+ \(bob@local\): до-копии-$S" "$L2")" = "1" ] \
  && ok "alice2: сообщение из копии без дублей" || bad "alice2: сообщение из копии задвоилось"

# ── новое сообщение после импорта ────────────────────────────────────────────
sleep 17 # bob перечитывает журнал alice раз в 15 с
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
  "PARVANE_AUTOSEND_V2=alice@local:после-копии-$S")
wait_log "$BL" "v2 → alice@local msg [0-9a-f-]+ \(text\)" 90 && ok "bob → alice ушло по v2" || bad "bob → alice не ушло по v2"
wait_log "$L2" "входящее msg [0-9a-f-]+ \(bob@local\): после-копии-$S" 60 && ok "alice2 читает новое сообщение" \
  || bad "alice2 не прочитала новое сообщение"

if grep -qE "запись не открыта|ошибка записи|E2E не удался" "$L2" "$BL"; then
  bad "в логах есть сбои записей v2"
else
  ok "сбоев записей v2 нет"
fi
grep -qiE "Fatal|Unexpected in " "$L1" "$L2" "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$P1"; stop_pid "$P2"; stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_keys_backup"
