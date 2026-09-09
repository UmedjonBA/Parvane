#!/usr/bin/env bash
# Единственный источник истины о путях desktop-e2e: каталог форка, бинарь
# клиента, каталог шардов. Сорсится из verify_lib.sh и из скриптов, которым
# нужны только пути (без обвязки стека). Только присваивания, без сайд-эффектов.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
SHARD="$ROOT/../backend/target/debug"
