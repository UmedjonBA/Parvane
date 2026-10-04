#!/usr/bin/env bash
# Протокол v2 (spec 007, T079 + T110): режим чата «усиленная приватность» (L2,
# правило conformance L2-1), настройка «сообщения от незнакомых» и кадры
# перехода на v2 (E6) — два десктопа на v2.
#
# L2: alice включает режим в личном чате с bob → у обоих служебное сообщение
# чата, режим активен у обоих, присутствие не публикуется, «печатает» в этот
# чат не уходит; alice выключает → всё возвращается. Служебные сообщения
# переживают рестарт без повторов. Приватность: «сообщения от незнакомых:
# нет» уходит в identity.privacy.set и досылается после рестарта.
# E6: gateway в режиме notice → сервисное уведомление; disabled → диалог
# «обновите приложение», без разлогина и без цикла переподключений.
#
# Хуки (бинарь с -DPARVANE_DEV=ON): PARVANE_AUTOL2=<чат>:<on|off>[@сек][,…],
# PARVANE_AUTOTYPING=<собеседник>@сек[,…], PARVANE_AUTOSTRANGERS=<on|off>[@сек].
# Размеры конвертов на сетке клиентским логом не видны — их проверяют
# backend/protocol/tests/client_flow.rs и v2_l2_live (журнал инбокса сервера).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
S=$(date +%s)
SB="$ROOT/../local-workdirs/verify-protocol-v2-l2"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" \
  stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
sleep 1
A="$SB/alice"; B="$SB/bob"
AL="$A/td/log.txt"; BL="$B/td/log.txt"
WS_URL='ws://127.0.0.1:9222/ws'
V2=(PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)

# ── L2 в личном чате ─────────────────────────────────────────────────────────
PB=$(start_client "$B" bob@local "${V2[@]}" PARVANE_GATEWAY_URL="$WS_URL" \
  "PARVANE_AUTOSEND_V2=alice@local:l2-b1-$S")
PA=$(start_client "$A" alice@local "${V2[@]}" \
  "PARVANE_AUTOSEND_V2=bob@local:l2-a1-$S" \
  "PARVANE_AUTOTYPING=bob@local@12,bob@local@40,bob@local@80" \
  "PARVANE_AUTOSTRANGERS=off@15" \
  "PARVANE_AUTOL2=bob@local:on@25,off@60")
wait_log "$AL" "v2: готов" 90 && ok "alice: v2-сессия готова" || bad "alice: v2 не поднялся"
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия готова" || bad "bob: v2 не поднялся"
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): l2-a1-$S" 90 && ok "обычная переписка по v2 идёт" \
  || bad "bob не получил текст alice"

# До режима: «печатает» уходит, присутствие публикуется.
wait_log "$AL" "autotyping → bob@local: отправлен" 60 && ok "до режима: «печатает» уходит" \
  || bad "до режима: «печатает» не ушёл"
grep -q "режим L2 — активных чатов 0, присутствие публикуется" "$AL" \
  && ok "до режима: присутствие публикуется" || bad "до режима: нет состояния L2 в логе"

# Приватность (часть A).
wait_log "$AL" "приватность: сообщения от незнакомых — запрещены" 60 && ok "alice: настройка сохранена на устройстве" \
  || bad "alice: настройка «незнакомые» не сохранена"
wait_log "$AL" "приватность сохранена: незнакомые нет" 30 && ok "alice: identity.privacy.set принят сервером" \
  || bad "alice: приватность не ушла на сервер"

# Включение.
wait_log "$AL" "режим L2 чата bob@local: включён" 60 && ok "alice: операция ChatMode отправлена" \
  || bad "alice: режим не включён"
wait_log "$AL" "режим L2 чата bob@local: включён \(мной\) — служебное сообщение" 30 \
  && ok "alice: своё служебное сообщение в чате" || bad "alice: нет своего служебного сообщения"
wait_log "$BL" "режим L2 чата alice@local: включён \(alice@local\) — служебное сообщение" 60 \
  && ok "bob: служебное сообщение «alice включил(а)…» (режим виден собеседнику)" || bad "bob: нет служебного сообщения"
wait_log "$AL" "режим L2 — активных чатов 1, присутствие не публикуется" 30 && ok "alice: режим активен, присутствие закрыто" \
  || bad "alice: режим не активен"
wait_log "$BL" "режим L2 — активных чатов 1, присутствие не публикуется" 30 \
  && ok "bob: режим активен по просьбе собеседника, присутствие закрыто" || bad "bob: режим не активен"
wait_log "$AL" "autotyping → bob@local: подавлен \(L2\)" 60 && ok "в режиме: «печатает» не уходит (L2-1)" \
  || bad "в режиме: «печатает» ушёл"

# Выключение.
wait_log "$AL" "режим L2 чата bob@local: выключен \(мной\) — служебное сообщение" 90 \
  && ok "alice: служебное сообщение о выключении" || bad "alice: режим не выключен"
wait_log "$BL" "режим L2 чата alice@local: выключен \(alice@local\) — служебное сообщение" 60 \
  && ok "bob: служебное сообщение о выключении" || bad "bob: нет сообщения о выключении"
wait_log "$BL" "режим L2 — активных чатов 0, присутствие публикуется" 30 && ok "bob: режим снят, присутствие открыто" \
  || bad "bob: режим не снят"
# третий «печатает» хука — на 80-й секунде; wait_log тут не годится (первое вхождение уже есть)
for _ in $(seq 1 60); do [ "$(grep -c "autotyping → bob@local: отправлен" "$AL")" -ge 2 ] && break; sleep 1; done
[ "$(grep -c "autotyping → bob@local: отправлен" "$AL")" -ge 2 ] && ok "после режима: «печатает» снова уходит" \
  || bad "после режима: «печатает» не восстановился"
if grep -qE "E2E не удался|НЕ расшифровано|запись не открыта" "$AL" "$BL"; then
  bad "в логах есть сбои E2E/записей v2"
else
  ok "сбоев E2E и записей v2 нет"
fi

# Рестарт: служебные сообщения из журнала — по одному разу; приватность читается с сервера.
stop_pid "$PA"; stop_pid "$PB"
PA=$(start_client "$A" alice@local "${V2[@]}")
PB=$(start_client "$B" bob@local "${V2[@]}" PARVANE_GATEWAY_URL="$WS_URL")
wait_log "$AL" "история: воспроизведено" 60 || bad "alice: история не воспроизведена"
wait_log "$BL" "история: воспроизведено" 60 || bad "bob: история не воспроизведена"
[ "$(grep -c "режим L2 чата bob@local: включён (мной) — служебное сообщение" "$AL")" = 1 ] \
  && ok "alice: своё служебное сообщение пережило рестарт без повтора" || bad "alice: служебное сообщение после рестарта"
[ "$(grep -c "режим L2 чата alice@local: включён (alice@local) — служебное сообщение" "$BL")" = 1 ] \
  && ok "bob: служебное сообщение пережило рестарт без повтора" || bad "bob: служебное сообщение после рестарта"
# T132 (FR-040): правка уже принята сервером — после рестарта не досылается, а читается с сервера
wait_log "$AL" "приватность с сервера: незнакомые нет" 90 && ok "alice: приватность после рестарта прочитана с сервера" \
  || bad "alice: приватность после рестарта не прочитана с сервера"
stop_pid "$PA"; stop_pid "$PB"

# ── E6: кадры перехода на v2 (последним блоком: после disabled клиент ждёт) ──
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed PARVANE_V1_MODE=notice" gateway_restart
PA=$(start_client "$A" alice@local "${V2[@]}")
wait_log "$AL" "upgrade_available\) — сервисное уведомление" 90 && ok "notice: нативное сервисное уведомление «доступна новая версия»" \
  || bad "notice: уведомления нет"
[ "$(grep -c "upgrade_available) — сервисное уведомление" "$AL")" = 1 ] && ok "notice: один раз за запуск" \
  || bad "notice: уведомление повторилось"
wait_log "$AL" "v2: готов" 90 && ok "notice: клиент работает дальше (v1 и v2)" || bad "notice: v2 не поднялся"
stop_pid "$PA"

PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed PARVANE_V1_MODE=disabled" gateway_restart
PA=$(start_client "$A" alice@local "${V2[@]}")
# T134: клиент на v2 без v1 работоспособен — диалога «обновите приложение» нет,
# он продолжает работать методами v2 (подробно — verify_protocol_v2_v1off.sh)
wait_log "$AL" "upgrade_required\) — работаем по v2" 90 && ok "disabled: клиент отметил отключение v1 и работает по v2" \
  || bad "disabled: нет отметки об отключении v1"
wait_log "$AL" "v2: готов" 90 && ok "disabled: v2-сессия поднялась без соединения v1" || bad "disabled: v2 не поднялся"
sleep 20
grep -q "upgrade_required) — нужна новая версия" "$AL" && bad "disabled: клиент на v2 показал «обновите приложение»" \
  || ok "disabled: диалога «обновите приложение» нет"
grep -q "авторизация отклонена" "$AL" && bad "disabled: клиент разлогинился (учётные данные должны остаться)" \
  || ok "disabled: без разлогина"
[ -s "$A/td/tdata/parvane-session.txt" ] && ok "disabled: учётные данные на диске" || bad "disabled: учётные данные пропали"
[ "$(grep -c "upgrade_required) — работаем по v2" "$AL")" = 1 ] && ok "disabled: отметка одна, без цикла переподключений v1" \
  || bad "disabled: цикл переподключений v1"
stop_pid "$PA"

stack_stop
finish "verify_protocol_v2_l2"
