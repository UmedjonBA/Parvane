#!/usr/bin/env bash
PV_V1_OFF=0 # сценарий сам задаёт режим v1 gateway (либо проверяет транспорт v1) — общий режим «без v1» не для него
# Живой e2e Фазы 0: поднимает nats + identity + messenger + gateway и гоняет
# parvane_gateway_probe — проверяет регистрацию/логин/auth через gateway и
# ИЗОЛЯЦИЮ (чужой инбокс не читается). Плоский NATS без auth-конфига (gateway
# без PARVANE_NATS_PASS подключается без креды).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
SB=${SCRATCH:-/tmp/parvane-phase0}
mkdir -p "$SB"
PROBE="$ROOT/parvane-core/build/parvane_gateway_probe"

command -v nats-server >/dev/null || { echo "нет nats-server"; exit 3; }
[ -x "$PROBE" ] || { echo "нет probe: собери parvane_gateway_probe"; exit 3; }

stack_start "$SB"   # с полной очисткой каталога прошлого прогона

"$PROBE" 127.0.0.1 9223
RC=$?

clients_kill "$SB"; stack_stop
exit $RC
