#!/usr/bin/env bash
# Линковка истории в форке X: alice(десктоп, история от bob) грантит оффер телефона → X импортирует → чат bob виден
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
cd /mnt/hdd/ub/Projects/active/Parvane/android
. ../desktop/verify_lib.sh
pkill -x nats-server 2>/dev/null; pkill -f "backend/target/debug[/]" 2>/dev/null; pkill -f "workdir /tmp/pv-tg[x]" 2>/dev/null; sleep 2
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"; stack_start "$SB"; STAMP=$(date +%s)
B="$SB/bob"; mkdir -p "$B/td"; BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$B/td/log.txt" "E2E-устройство готово" 90 && ok "bob готов" || bad "bob не поднялся"
A="$SB/alice"; mkdir -p "$A/td"; AP=$(start_client "$A" alice@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOLINK_GRANT=1)
wait_log "$A/td/log.txt" "E2E-устройство готово" 90 && ok "alice (десктоп, грантует) готова" || bad "alice не поднялась"
stop_pid "$BP"; BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:history-$STAMP")
wait_log "$A/td/log.txt" "входящее msg .*bob@local.*history-$STAMP" 60 && ok "у alice есть история от bob" || bad "alice не получила от bob"
echo "STACK_SB=$SB"
AVD=parvane33 WAIT_SECS=20 ./tgx_session_flow.sh /tmp/pv-tgx-session alice@local test
ad() { timeout 25 adb "$@"; }
timeout 120 bash -c 'until adb logcat -d 2>/dev/null | grep -q "линковка: история получена"; do sleep 3; done' && ok "X: история импортирована по линковке" || bad "X: линковка не завершилась"
grep -a "линковка" "$A/td/log.txt" | tail -3 | cut -c1-140
adb logcat -d | grep -a "линковка\|входящее msg\|AndroidRuntime" | tail -8 | cut -c1-160
sleep 8; ad exec-out screencap -p > /tmp/pv-tgx-link-list.png
echo "LINK_E2E_DONE rc=$RC"
