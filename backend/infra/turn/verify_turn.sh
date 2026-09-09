#!/usr/bin/env bash
# Проверка TURN/STUN сервера Parvane: поднимает parvane-turn и клиентом делает
# allocation. Успех = "RELAY OK" (сервер выдал релей-адрес) + STUN mapped.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"
export PATH="$HOME/.local/bin:$PATH"; export GOFLAGS=-mod=mod
[ -x ./parvane-turn ] || go build -o parvane-turn . || { echo "не собрать сервер"; exit 2; }
[ -x ./turntest/turntest ] || go build -o turntest/turntest ./turntest || { echo "не собрать клиент"; exit 2; }
pkill -x parvane-turn 2>/dev/null; sleep 1
TURN_PUBLIC_IP=127.0.0.1 setsid nohup ./parvane-turn >/tmp/parvane-turnsrv.log 2>&1 </dev/null & disown
sleep 2
OUT=$(./turntest/turntest 2>&1)
pkill -x parvane-turn 2>/dev/null
echo "$OUT"
if echo "$OUT" | grep -q 'RELAY OK'; then
    echo -e "\033[32mTURN/STUN: РАБОТАЕТ (relay + stun)\033[0m"; exit 0
else
    echo -e "\033[31mTURN/STUN: ПРОВАЛ\033[0m"; exit 1
fi
