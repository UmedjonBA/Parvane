#!/usr/bin/env bash
# Протокол v2 (spec 007, SC-007/FR-004, T139): десктоп получает 10 сообщений
# неизвестного вида подряд — 10 заглушек «не поддерживается», журнал инбокса не
# застревает: обычный текст ПОСЛЕ них доставлен и показан. Отправитель — Rust-
# инжектор `backend/tests/integration/tests/v2_inject.rs` (фича test-inject,
# тот же, что у web-пары `unknown-kinds`).
# Бинарь tdesktop — с -DPARVANE_DEV=ON. Инжектор собирается здесь (cargo --no-run).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
N=10
SB="$ROOT/../local-workdirs/verify-protocol-v2-unknown"
(cd "$ROOT/../backend" && cargo test -q -p parvane-integration --test v2_inject --no-run >"$SB.build.log" 2>&1) \
  || bad "инжектор не собрался (см. $SB.build.log)"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
B="$SB/bob"; BL="$B/td/log.txt"
INJ="inj$S@local"; FINAL="после-неизвестных-$S"

PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"

(cd "$ROOT/../backend" && PARVANE_INJECT_GATEWAY_TCP=127.0.0.1:9223 PARVANE_INJECT_FROM="$INJ" \
  PARVANE_INJECT_TO=bob@local PARVANE_INJECT_TEXT="$FINAL" PARVANE_INJECT_COUNT=$N \
  timeout 300 cargo test -q -p parvane-integration --test v2_inject -- --ignored --nocapture >"$SB/inject.log" 2>&1)
grep -q "INJECT OK" "$SB/inject.log" && ok "инжектор отправил $N неизвестных + текст" || bad "инжектор не отработал (см. $SB/inject.log)"

wait_log "$BL" "входящее msg [0-9a-f-]+ \($INJ\): $FINAL" 90 && ok "bob: текст после неизвестных доставлен (журнал не застрял)" \
  || bad "bob: текст после неизвестных не пришёл"
STUBS=$(grep -c "заглушка unsupported msg [0-9a-f-]* ($INJ)" "$BL")
[ "$STUBS" = "$N" ] && ok "bob: $N заглушек «не поддерживается»" || bad "bob: заглушек $STUBS, ожидалось $N"
LAST_STUB=$(grep -n "заглушка unsupported msg [0-9a-f-]* ($INJ)" "$BL" | tail -1 | cut -d: -f1)
TEXT_AT=$(grep -n "входящее msg [0-9a-f-]* ($INJ): $FINAL" "$BL" | head -1 | cut -d: -f1)
[ -n "$LAST_STUB" ] && [ -n "$TEXT_AT" ] && [ "$TEXT_AT" -gt "$LAST_STUB" ] \
  && ok "порядок: текст после всех заглушек" || bad "порядок: заглушка $LAST_STUB, текст $TEXT_AT"

# Рестарт: заглушки и текст не пропали и не задвоились (курсор журнала не откатился)
stop_pid "$PB"
PB=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся после рестарта"
sleep 8
[ "$(grep -c "входящее msg [0-9a-f-]* ($INJ): $FINAL" "$BL")" -le 1 ] \
  && ok "после рестарта текст не задвоился" || bad "после рестарта текст пришёл повторно"
grep -qE "запись не открыта|ошибка записи" "$BL" && bad "в логах есть сбои записей v2" || ok "сбоев записей v2 нет"
grep -qiE "Fatal|Unexpected in " "$BL" && bad "фатальная ошибка" || ok "без фатальных ошибок"
stop_pid "$PB"
stack_stop
finish "verify_protocol_v2_unknown"
