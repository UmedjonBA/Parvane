#!/usr/bin/env bash
# Живой e2e Фазы 0: поднимает nats + identity + messenger + gateway и гоняет
# parvane_gateway_probe — проверяет регистрацию/логин/auth через gateway и
# ИЗОЛЯЦИЮ (чужой инбокс не читается). Плоский NATS без auth-конфига (gateway
# без PARVANE_NATS_PASS подключается без креды).
set -u
ROOT=/home/ub/Parvane
SB=${SCRATCH:-/tmp/parvane-phase0}
mkdir -p "$SB"
BIN=$ROOT/target/debug
PROBE=$ROOT/desktop/parvane-core/build/parvane_gateway_probe

command -v nats-server >/dev/null || { echo "нет nats-server"; exit 3; }
[ -x "$PROBE" ] || { echo "нет probe: собери parvane_gateway_probe"; exit 3; }

rm -f "$SB"/*.db*
nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!
sleep 1
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/identity.db" \
  PARVANE_LOG_LEVEL=warn "$BIN/identity" >"$SB/identity.log" 2>&1 & ID=$!
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$SB/messenger.db" \
  PARVANE_LOG_LEVEL=warn "$BIN/messenger" >"$SB/messenger.log" 2>&1 & MSG=$!
PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 \
  PARVANE_GATEWAY_BIND=127.0.0.1:9222 PARVANE_LOG_LEVEL=warn \
  "$BIN/gateway" >"$SB/gateway.log" 2>&1 & GW=$!
sleep 2

"$PROBE" 127.0.0.1 9223
RC=$?

kill "$GW" "$MSG" "$ID" "$NATS" 2>/dev/null
exit $RC
