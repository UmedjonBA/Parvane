#!/usr/bin/env bash
# spec 036 T036: прежняя версия X → новая на эмуляторе. Прежняя версия держала служебные файлы (сессия, владелец,
# файлы каталога состояния v2 — ключ и id устройства, кэш групп, ключи разделов…) файлами storecrypt; новая переносит
# каждый в хранилище движка при первом обращении (`host-files` каталога хранилища и `<каталог состояния>/host`):
# данные и отметка одной пачкой, сверка чтением, прежний файл → `.migrated`. «Прежняя версия» — та же debug-сборка с
# dev-хуком /data/local/tmp/parvane-store-legacy (только прежние файлы, как desktop PARVANE_STORE_LEGACY). Проверяется:
# после первого запуска новой версии — то же устройство (без привязки), переписка на месте и ходит, повторный запуск
# ничего не переносит заново. Данные — выдуманные. Свой стек (стенд /tmp/pv-tgx.*): в ORDER pipeline — последним.
#   ./tgx_store_migration_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-store-migration}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
S="$(date +%s)"
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"; stack_start "$SB"; echo "STACK_SB=$SB"
B="$SB/bob"; BL="$B/td/log.txt"; BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob (desktop) на v2" || bad "bob не поднялся"
emu_boot "$OUT" && ok "эмулятор" || { bad "эмулятор не загрузился"; finish "TGX STORE MIGRATION"; }
tgx_install && ok "APK установлен" || bad "APK не установился"

# ── «прежняя версия»: прежние файлы storecrypt ───────────────────────────────
tgx_put parvane-store-legacy 1
tgx_fresh alice@local
tgx_logwait "v2: готов" 120 && ok "alice (X, прежняя версия) на v2" || bad "сессия v2 X не поднялась"
tgx_mark
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:do-perenosa-$S")
tgx_logwait "сообщение .* → чат .* \(вх\)" 90 && ok "X получил сообщение bob" || bad "X не получил сообщение bob"
tgx_cmd "{\"op\":\"send\",\"peer\":\"bob@local\",\"text\":\"otvet-$S\"}" && ok "X ответил" || bad "команда отправки не выполнилась"
wait_log "$BL" "входящее msg .*alice@local.*otvet-$S" 60 && ok "bob получил ответ X" || bad "bob не получил ответ X"
sleep 5
grep -qa "перенесён в хранилище движка" "$TGX_LOG" && bad "прежняя версия переносила файлы" || ok "прежняя версия — без переноса"
LEGACY_FILES="$(a shell run-as "$TGX_PKG" sh -c 'find files -name session.json -o -name key -o -name host-files' 2>/dev/null | tr -d '\r')"
echo "$LEGACY_FILES" | grep -q "session.json" && ! echo "$LEGACY_FILES" | grep -q "host-files" \
  && ok "профиль прежней версии: session.json — файл storecrypt, хранилища файлов хоста нет" \
  || bad "профиль не похож на прежнюю версию: $LEGACY_FILES"
tgx_stop

# ── новая версия: перенос при первом запуске ──────────────────────────────────
a shell rm -f /data/local/tmp/parvane-store-legacy
tgx_start
tgx_logwait "файл перенесён в хранилище движка: session.json" 60 && ok "сессия перенесена (вход без пароля)" \
  || bad "session.json не перенесён"
tgx_logwait "хранилище: файл key перенесён в хранилище движка" 90 && ok "ключ устройства (каталог состояния) перенесён" \
  || bad "ключ устройства не перенесён"
tgx_logwait "v2: готов" 120 && ok "alice (X, новая версия) на v2" || bad "сессия v2 X не поднялась после переноса"
grep -qaE "нужна привязка|needsLinking|вход не удался" <(tail -n "+$TGX_MARK" "$TGX_LOG") && bad "после переноса — новое устройство" \
  || ok "то же устройство — без привязки заново"
grep -qaE "в карантине|не перенесён \(" <(tail -n "+$TGX_MARK" "$TGX_LOG") && bad "есть непереносимые файлы" \
  || ok "все файлы перенесены без карантина"
tgx_cmd "{\"op\":\"history\",\"peer\":\"bob@local\"}"
tgx_logwait "проверка истории bob@local: .*do-perenosa-$S.*otvet-$S" 30 && ok "переписка до переноса на месте (страницами модели)" \
  || bad "переписки до переноса нет"
tgx_mark
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:posle-perenosa-$S")
tgx_logwait "сообщение .* → чат .* \(вх\)" 90 && ok "после переноса X получает (ключи устройства те же)" \
  || bad "после переноса X не получает"
AFTER="$(a shell run-as "$TGX_PKG" sh -c 'find files -name session.json -o -name session.json.migrated -o -name host-files' 2>/dev/null | tr -d '\r')"
echo "$AFTER" | grep -q "session.json.migrated" && echo "$AFTER" | grep -q "host-files" && ! echo "$AFTER" | grep -qE "session.json$" \
  && ok "прежние файлы — .migrated, данные — в хранилище движка" || bad "раскладка после переноса не та: $AFTER"
sleep 3
tgx_stop

# ── повторный запуск: перенос не повторяется ─────────────────────────────────
tgx_start
tgx_logwait "v2: готов" 120 && ok "повторный запуск: v2 готова" || bad "повторный запуск: v2 не поднялась"
sleep 3
grep -qa "перенесён в хранилище движка" <(tail -n "+$TGX_MARK" "$TGX_LOG") && bad "перенос повторился" || ok "перенос не повторяется"
tgx_no_crash
stop_pid "$BP"
kill "$TGX_LCP" 2>/dev/null
stack_stop
finish "TGX STORE MIGRATION"
