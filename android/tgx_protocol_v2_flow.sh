#!/usr/bin/env bash
# Протокол v2 (spec 007, T067): смешанные пары desktop ↔ Telegram X (шов) в
# эмуляторе на изолированном локальном стеке. Пара — первый аргумент:
#   desktop2-android1 — bob desktop на v2 (PARVANE_PROTO_V2=1), alice — X на v1
#                       (флаг v2 выключен): у alice нет журнала устройств v2 →
#                       bob шлёт по v1 (D-13), текст в обе стороны, v2 не задействован;
#   desktop2-android2 — оба на v2: X без флага v1 (/data/local/tmp/parvane-proto-v1,
#                       debug) и JWT с claim dev → v2-сессия шва (устройство,
#                       журнал, ключ восстановления), bob → X по v2, X → bob по v2,
#                       незнакомый X вид (контакт) → TdApi.MessageUnsupported.
# Нужны: собранный X x64-debug APK с текущим libparvane_jni.so (tgx_build_x64.sh),
# AVD (по умолчанию parvane33) и обход mesa (tgx_session_flow.sh), бинарь
# desktop/build-probe/bin/Telegram с -DPARVANE_DEV=ON, шарды backend/target/debug.
# Фаза 2 spec 007 (T079/T110; заготовка, на эмуляторе ещё НЕ прогонялась):
#   - desktop2-android2: режим «усиленная приватность» (L2-1) в обе стороны и «сообщения от
#     незнакомых» — через e2e-хук шва (ops l2 / l2state / privacy), без тапов по UI;
#   - обе пары: кадры перехода gateway PARVANE_V1_MODE=notice|disabled (PV_UPGRADE_CHECK=0 — пропустить).
#   Нужен хук десктопа для смены режима (PV_DESKTOP_L2_HOOK, по умолчанию PARVANE_AUTOL2=<peer>:on|off).
#   ./tgx_protocol_v2_flow.sh desktop2-android1|desktop2-android2
set -u
PAIR="${1:-desktop2-android1}"
case "$PAIR" in desktop2-android1|desktop2-android2) ;; *) echo "неизвестная пара: $PAIR" >&2; exit 2 ;; esac
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_ui.sh"
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -aqE \"$1\"; do sleep 3; done"; }
xcount() { adb logcat -d 2>/dev/null | grep -acE "$1"; }
# Команда e2e-хука шва (файл читается раз в 3 с; следующую команду — только после маркера этой)
x_cmd() { printf '%s' "$1" > "$OUT/cmd"; ad push "$OUT/cmd" /data/local/tmp/parvane-e2e-cmd >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-e2e-cmd; xlog "$2" "${3:-40}"; }
PKG=org.parvane.tgx; ACT="$PKG/org.thunderdog.challegram.MainActivity"
OUT="/tmp/pv-tgx-proto-$PAIR"; mkdir -p "$OUT"; S=$(date +%s)

# Стек как в tgx_link_e2e.sh (фиксированные порты 4222/9222/9223 — эмулятор ходит на 10.0.2.2:9222),
# gateway с фичей sealed и identity в dev-режиме — как desktop/verify_protocol_v2.sh.
pkill -x nats-server 2>/dev/null; pkill -f "backend/target/debug[/]" 2>/dev/null; pkill -f "workdir /tmp/pv-tg[x]" 2>/dev/null; sleep 2
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
A="$SB/alice"; B="$SB/bob"; BL="$B/td/log.txt"
# alice регистрируется десктопом на v1 (журнала устройств v2 у неё не будет) и гасится
AP=$(start_client "$A" alice@local PARVANE_PROTO_V2=0 PARVANE_NO_LINK_OFFER=1)
wait_log "$A/td/log.txt" "E2E-устройство готово" 90 && ok "alice зарегистрирована (desktop v1)" || bad "alice не поднялась"
stop_pid "$AP"
BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 && ok "bob: v2-сессия desktop готова" || bad "bob: v2 не поднялся"

# X как устройство alice (сессия подкладывается — экран пароля роняет qemu)
[ "$PAIR" = "desktop2-android2" ] && V2=1 || V2=0
TGX_PROTO_V1=$((1 - V2)) AVD="${AVD:-parvane33}" WAIT_SECS=20 "$HERE/tgx_session_flow.sh" "$OUT/session" alice@local "$PV_PASSWORD" >"$OUT/session-flow.log" 2>&1
grep -q "сессия поднята (ядро)" "$OUT/session-flow.log" && ok "X: сессия alice поднята" || { bad "X: сессия не поднялась (см. $OUT/session-flow.log)"; stop_pid "$BP"; stack_stop; finish "TGX PROTO $PAIR"; }
if [ "$V2" = 1 ]; then
  # v2 требует JWT с claim dev: перевыпуск под device_id ядра X (как FAIL-1 в tgx_conformance_flow.sh)
  # JWT X уже с claim dev (tgx_session_flow.sh задаёт device_id заранее) — v2 его требует
  # v2 включён по умолчанию (T135); остаться на v1 — файл-флаг parvane-proto-v1
  ad shell rm -f /data/local/tmp/parvane-proto-v1
else
  echo 1 > "$OUT/flag"; ad push "$OUT/flag" /data/local/tmp/parvane-proto-v1 >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-proto-v1
fi
ad shell rm -f /data/local/tmp/parvane-e2e-cmd # команда прошлого прогона (root-файл) выполнилась бы при старте
x_force_stop $PKG; ad logcat -c; ad shell am start -n "$ACT" >/dev/null 2>&1
xlog "сессия поднята" 60 && ok "X перезапущен" || bad "X не поднял сессию после перезапуска"
if [ "$V2" = 1 ]; then
  xlog "v2: готов" 90 && ok "X: v2-сессия шва готова" || bad "X: v2-сессия не поднялась"
  # v2 включён по умолчанию (T135): устройство и ключ восстановления создаются уже при первом запуске в
  # tgx_session_flow.sh, до очистки logcat — после перезапуска X поднимает сохранённое состояние
  xlog "v2: устройство создано|v2: состояние устройства загружено" 30 && ok "X: устройство v2 есть (создано либо поднято из состояния)" \
    || bad "X: устройства v2 нет"
else
  sleep 8
  adb logcat -d | grep -aq "v2: сессия запускается" && bad "X: v2 поднялся без флага" || ok "X: v2 выключен по умолчанию"
fi

# bob → alice штатным путём (перезапуск bob с autosend)
# messenger кэширует список устройств получателя 30 с (DEVICES_TTL, v2.rs): новое
# v2-устройство X в этом окне не получает sealed-доставку (accepted=0 молча).
[ "$V2" = 1 ] && sleep 32
stop_pid "$BP"
if [ "$V2" = 1 ]; then
  BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
    "PARVANE_AUTOSEND_V2=alice@local:v2-b1-$S|{\"contact\":{\"first_name\":\"Ivan\"}}")
else
  BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 PARVANE_AUTOSEND="alice@local:v1-b1-$S")
fi
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся после рестарта"
if [ "$V2" = 1 ]; then
  wait_log "$BL" "v2 → alice@local msg [0-9a-f-]+ \(text\)" 90 && ok "bob → X ушло по v2 (журнал alice v2)" || bad "bob → X не ушло по v2"
  xlog "v2 ← входящее msg [0-9a-f-]+ \(text\)" 90 && ok "X: текст bob принят движком v2" || bad "X: нет v2-приёма текста"
  xlog "v2 ← входящее msg [0-9a-f-]+ \(unsupported\)" 60 && ok "X: незнакомый вид → заглушка unsupported" || bad "X: нет заглушки unsupported"
  # SC-007 (T139): 10 неизвестных видов подряд от Rust-инжектора — 10 заглушек, журнал не застревает
  UNK_BEFORE=$(adb logcat -d | grep -acE "v2 ← входящее msg [0-9a-f-]+ \(unsupported\)")
  (cd "$HERE/../backend" && cargo test -q -p parvane-integration --test v2_inject --no-run >"$OUT/inject-build.log" 2>&1 \
    && PARVANE_INJECT_GATEWAY_TCP=127.0.0.1:9223 PARVANE_INJECT_FROM="inj$S@local" PARVANE_INJECT_TO=alice@local \
       PARVANE_INJECT_TEXT="после-неизвестных-$S" PARVANE_INJECT_COUNT=10 \
       timeout 300 cargo test -q -p parvane-integration --test v2_inject -- --ignored --nocapture >"$OUT/inject.log" 2>&1)
  grep -q "INJECT OK" "$OUT/inject.log" && ok "инжектор: 10 неизвестных + текст" || bad "инжектор не отработал (см. $OUT/inject.log)"
  for _ in $(seq 1 30); do
    [ "$(adb logcat -d | grep -acE "v2 ← входящее msg [0-9a-f-]+ \(unsupported\)")" -ge $((UNK_BEFORE + 10)) ] && break; sleep 3
  done
  UNK_AFTER=$(adb logcat -d | grep -acE "v2 ← входящее msg [0-9a-f-]+ \(unsupported\)")
  [ "$UNK_AFTER" -ge $((UNK_BEFORE + 10)) ] && ok "X: 10 заглушек unsupported подряд (SC-007)" || bad "X: заглушек $((UNK_AFTER - UNK_BEFORE)) из 10"
  # текст после них дошёл: последняя v2-строка от инжектора — text, после всех заглушек
  LAST_UNK=$(adb logcat -d | grep -anE "v2 ← входящее msg [0-9a-f-]+ \(unsupported\)" | tail -1 | cut -d: -f1)
  xlog "v2 ← входящее msg [0-9a-f-]+ \(text\)" 5 >/dev/null
  TEXT_AT=$(adb logcat -d | grep -anE "v2 ← входящее msg [0-9a-f-]+ \(text\)" | tail -1 | cut -d: -f1)
  [ -n "$LAST_UNK" ] && [ -n "$TEXT_AT" ] && [ "$TEXT_AT" -gt "$LAST_UNK" ] \
    && ok "X: текст после неизвестных доставлен (журнал не застрял)" || bad "X: текст после неизвестных не пришёл"
else
  wait_log "$BL" "autosend → alice@local" 60 && ok "bob отправил alice" || bad "bob не отправил"
  grep -qE "v2 → alice@local msg" "$BL" && bad "bob → alice ушло по v2, хотя у alice нет журнала v2" || ok "bob → alice по v1 (у alice нет журнала v2, D-13)"
fi
xlog "сообщение [0-9a-f-]+ → чат [0-9-]+ \(вх\)" 60 && ok "X: входящее в чате (тот же конвейер, что v1)" || bad "X: входящее не дошло до чата"

# X → bob через e2e-хук шва (штатный SendMessage → sendContent)
printf '{"op":"send","peer":"bob@local","text":"x-reply-%s"}' "$S" > "$OUT/cmd"
ad push "$OUT/cmd" /data/local/tmp/parvane-e2e-cmd >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-e2e-cmd
xlog "e2e-cmd send" 30 || bad "X: e2e-команда send не выполнена"
if [ "$V2" = 1 ]; then
  xlog "v2 → msg [0-9a-f-]+ \(text\)" 60 && ok "X → bob ушло по v2" || bad "X → bob не ушло по v2"
  wait_log "$BL" "v2 ← alice@local msg" 60 && ok "bob: приём от X через движок v2" || bad "bob: нет v2-приёма от X"
else
  sleep 5
  adb logcat -d | grep -aqE "v2 → msg" && bad "X ушло по v2 без флага" || ok "X → bob по v1"
fi
wait_log "$BL" "входящее msg [0-9a-f-]+ \(alice@local\): x-reply-$S" 60 && ok "bob получил ответ из X" || bad "bob не получил ответ из X"

# ── spec 007, T079 (фаза 2): режим «усиленная приватность» (правило L2-1) и «сообщения от незнакомых» ──
# Состояние режима проверяется по logcat шва (хук l2state; без текста сообщений — P-46).
if [ "$V2" = 1 ]; then
  # X включает режим в чате с bob — тот же путь шва, что строка-переключатель профиля X
  x_cmd '{"op":"l2","peer":"bob@local","on":true}' "режим L2 чата [0-9-]+: включён \(своё действие\)" 60 \
    && ok "X: режим L2 включён (SetOption x_parvane_l2)" || bad "X: режим L2 не включился"
  xlog "режим L2 чата [0-9-]+: включён \(служебное [0-9a-f-]+, своё\)" 30 && ok "X: своё служебное сообщение о режиме" || bad "X: нет своего служебного сообщения"
  xlog "режим L2: активных чатов 1, присутствие не публикуется" 30 && ok "X: кэш l2State — присутствие не публикуется" || bad "X: кэш l2State не обновился"
  wait_log "$BL" "режим L2 чата alice@local: включён \(alice@local\) — служебное сообщение" 60 && ok "bob (desktop) видит: alice включила режим" || bad "bob не увидел включение режима"
  x_cmd '{"op":"l2state","peer":"bob@local"}' "l2 состояние чата [0-9-]+: active=true mine=true by_peer=false typing=false presence=false" 30 \
    && ok "X: состояние — включён мной, typing/presence закрыты" || bad "X: неверное состояние режима после включения"
  # X выключает — режим снят, присутствие снова публикуется
  x_cmd '{"op":"l2","peer":"bob@local","on":false}' "режим L2 чата [0-9-]+: выключен \(своё действие\)" 60 && ok "X: режим L2 выключен" || bad "X: режим L2 не выключился"
  xlog "режим L2: активных чатов 0, присутствие публикуется" 30 && ok "X: режим снят, присутствие публикуется" || bad "X: режим не снят"
  wait_log "$BL" "режим L2 чата alice@local: выключен \(alice@local\) — служебное сообщение" 60 && ok "bob видит: alice выключила режим" || bad "bob не увидел выключение режима"
  # bob (desktop) включает режим — X видит чужое служебное сообщение и «включена собеседником»
  stop_pid "$BP"
  BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 "${PV_DESKTOP_L2_HOOK:-PARVANE_AUTOL2=alice@local:on}")
  wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся после рестарта (L2)"
  wait_log "$BL" "режим L2 чата alice@local: включён \(мной\) — служебное сообщение" 90 && ok "bob (desktop) включил режим" || bad "bob не включил режим (нужен хук десктопа PARVANE_AUTOL2)"
  xlog "режим L2 чата [0-9-]+: включён \(служебное [0-9a-f-]+, чужое\)" 90 && ok "X: служебное сообщение о режиме от bob" || bad "X: нет служебного сообщения от bob"
  x_cmd '{"op":"l2state","peer":"bob@local"}' "l2 состояние чата [0-9-]+: active=true mine=false by_peer=true typing=false presence=false" 30 \
    && ok "X: режим активен из-за собеседника («включена собеседником»)" || bad "X: неверное состояние режима от собеседника"
  # T079 / FR-040: «сообщения от незнакомых» — тот же путь шва, что экран Privacy → Messages (SetNewChatPrivacySettings)
  x_cmd '{"op":"privacy","peer":"bob@local","strangers":false}' "приватность сохранена: незнакомые нет" 60 \
    && ok "X: identity.privacy.set — незнакомые нет" || bad "X: приватность не сохранена"
fi

# Группа v2 (T056): bob-десктоп создаёт группу с alice (оба на v2 → журнал группы,
# эпохи), пишет; X получает группу из журнала и групповое сообщение в чат группы.
if [ "$V2" = 1 ]; then
  stop_pid "$BP"
  BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 \
    "PARVANE_AUTOGROUP=GX-$S:alice@local" "PARVANE_AUTOGROUPSEND=GX-$S:gx-$S")
  wait_log "$BL" "группа v2 'GX-$S' создана: v2g:[0-9a-f]{32}" 90 && ok "bob: группа v2 с X создана" || bad "bob: группа v2 не создана"
  GID=$(grep -aoE "группа v2 'GX-$S' создана: v2g:[0-9a-f]{32}" "$BL" | grep -oE 'v2g:[0-9a-f]{32}' | head -1)
  xlog "группа v2 $GID (появилась|обновлена)" 90 && ok "X: группа v2 из проверенного журнала" || bad "X: группа v2 не появилась"
  wait_log "$BL" "v2 → $GID msg [0-9a-f-]+ \(text\)" 90 && ok "bob → группа по v2" || bad "bob → группа не ушло по v2"
  GU=$(grep -aoE "v2 → $GID msg [0-9a-f-]{36}" "$BL" | head -1 | awk '{print $5}')
  [ -n "$GU" ] && xlog "сообщение $GU → чат -[0-9]+ \\(вх\\)" 90 && ok "X: групповое v2 в чате группы" || bad "X: групповое v2 ($GU) не дошло"
fi

# ── E6, T110 (фаза 2): кадры перехода gateway на v1-соединении X ──
if [ "${PV_UPGRADE_CHECK:-1}" = 1 ]; then
  GWENV="PARVANE_V2_FEATURES=sealed"
  # notice: v1 работает; после входа — кадр upgrade_available → UpdateServiceNotification ОДИН раз за запуск
  PV_GATEWAY_ENV="$GWENV PARVANE_V1_MODE=notice" gateway_restart
  xlog "gateway: доступна новая версия \(upgrade_available\)" 60 && ok "X: кадр upgrade_available получен" || bad "X: нет кадра upgrade_available"
  xlog "доступна новая версия → X UpdateServiceNotification" 20 && ok "X: уведомление «доступна новая версия»" || bad "X: нет уведомления о новой версии"
  PV_GATEWAY_ENV="$GWENV PARVANE_V1_MODE=notice" gateway_restart; sleep 15 # повторный вход — второй кадр, уведомление не повторяется
  [ "$(xcount "доступна новая версия → X UpdateServiceNotification")" = 1 ] && ok "X: уведомление показано один раз" || bad "X: уведомление о новой версии повторилось"
  # disabled: v1 отключён. Клиент на v2 без него работоспособен (T134, правило E6-1): диалога «обновите
  # приложение» нет, сессия остаётся, переподключения v1 не крутятся
  PV_GATEWAY_ENV="$GWENV PARVANE_V1_MODE=disabled" gateway_restart
  xlog "gateway: v1 отключён сервером \(upgrade_required\)" 60 && ok "X: кадр upgrade_required получен" || bad "X: нет кадра upgrade_required"
  xlog "upgrade_required\) — работаем по v2" 20 && ok "X: отключение v1 отмечено, клиент работает по v2" || bad "X: нет отметки о работе без v1"
  sleep 60
  [ "$(xcount "v1 отключён сервером → X UpdateServiceNotification")" = 0 ] && ok "X: диалога «обновите приложение» нет" || bad "X на v2 показал диалог об обновлении"
  [ "$(xcount "gateway: v1 отключён сервером \(upgrade_required\)")" -le 2 ] && ok "X: переподключения не крутятся (пауза транспорта 5 мин)" || bad "X: цикл переподключений при upgrade_required"
  adb logcat -d | grep -aq "сессия истекла → экран входа" && bad "X: upgrade_required разлогинил (учётные данные должны остаться)" || ok "X: сессия сохранена при upgrade_required"
  PV_GATEWAY_ENV="$GWENV" gateway_restart # вернуть обычный режим (X переподключится сам в пределах 5 минут)
fi

ad logcat -d -v time > "$OUT/logcat.txt"; ad exec-out screencap -p > "$OUT/final.png"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "X: краш (AndroidRuntime)" || ok "X без крашей"
grep -aqE "запись не открыта|E2E не удался" "$OUT/logcat.txt" "$BL" && bad "сбои записей/E2E в логах" || ok "сбоев записей v2/E2E нет"
ad shell rm -f /data/local/tmp/parvane-proto-v1
stop_pid "$BP"; stack_stop
echo "STACK_SB=$SB OUT=$OUT"
finish "TGX PROTO $PAIR"
