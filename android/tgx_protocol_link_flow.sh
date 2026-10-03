#!/usr/bin/env bash
# Протокол v2 (spec 007): Telegram X (шов) как ВТОРОЕ v2-устройство аккаунта —
# приём гранта линковки (LINK-1 v2) в эмуляторе, изолированный локальный стек.
# alice-desktop — первое v2-устройство (корень, журнал устройств, ключ личного
# состояния; PARVANE_AUTOLINK_GRANT=1 — подтверждение без UI). X входит как
# alice, включается флаг v2: журнал у аккаунта уже есть → X своего корня НЕ
# создаёт, публикует оффер (хотя история v1 уже перенесена первым грантом),
# десктоп выдаёт грант с материалом движка вторым блобом, X вступает в журнал
# устройств и поднимает v2-сессию с журналом личного состояния. Затем сообщение
# bob по v2 читают оба устройства alice.
# Нужны: x64-debug APK X с текущим libparvane_jni.so (tgx_build_x64.sh), AVD
# (parvane33) и обход mesa (tgx_session_flow.sh), бинарь desktop с -DPARVANE_DEV=ON.
#   ./tgx_protocol_link_flow.sh
set -u
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/mnt/hdd/ub/android/sdk/platform-tools:$PATH"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_ui.sh"
ad() { timeout 30 adb "$@"; }
xlog() { timeout "${2:-90}" bash -c "until adb logcat -d 2>/dev/null | grep -aqE \"$1\"; do sleep 3; done"; }
PKG=org.parvane.tgx; ACT="$PKG/org.thunderdog.challegram.MainActivity"
OUT="/tmp/pv-tgx-proto-link"; mkdir -p "$OUT"; S=$(date +%s)

pkill -x nats-server 2>/dev/null; pkill -f "backend/target/debug[/]" 2>/dev/null; pkill -f "workdir /tmp/pv-tg[x]" 2>/dev/null; sleep 2
SB="$(mktemp -d /tmp/pv-tgx.XXXXXX)"
PV_GATEWAY_ENV="PARVANE_V2_FEATURES=sealed" stack_start "$SB" PARVANE_DEV=1 PARVANE_WELL_KNOWN_FILE="$SB/parvane.json"
wait_log "$SB/identity.log" "Identity шард запущен" 60 || bad "identity не поднялся"
wait_log "$SB/messenger.log" "Messenger шард запущен" 60 || bad "messenger не поднялся"
A="$SB/alice"; B="$SB/bob"; AL="$A/td/log.txt"; BL="$B/td/log.txt"

# bob — первым: его журнал устройств v2 нужен alice для группы v2 (T142)
BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1)
wait_log "$BL" "v2: готов" 90 || bad "bob: v2 не поднялся"
stop_pid "$BP"
G="ГруппаX$S"
# alice-desktop — первое v2-устройство, выдаёт гранты без UI; bob пишет ей по v2
AP=$(start_client "$A" alice@local PARVANE_PROTO_V2=1 PARVANE_AUTOLINK_GRANT=1 "PARVANE_AUTOGROUP=$G:bob@local")
wait_log "$AL" "v2: готов" 90 && ok "alice-desktop: первое v2-устройство готово" || bad "alice-desktop: v2 не поднялся"
wait_log "$AL" "журнал личного состояния подключён" 60 && ok "alice-desktop: журнал личного состояния подключён" || bad "alice-desktop: журнал состояния не подключён"
BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:до-линковки-$S")
wait_log "$AL" "входящее msg [0-9a-f-]+ \(bob@local\): до-линковки-$S" 90 && ok "alice-desktop получила текст bob по v2" || bad "alice-desktop не получила текст bob"
wait_log "$AL" "группа v2 '$G' создана: v2g:[0-9a-f]{32}" 60 && ok "alice-desktop: группа v2 создана" || bad "alice-desktop: группа v2 не создана"

# X как устройство alice: сессия подкладывается (экран пароля роняет qemu), сначала БЕЗ флага v2
AVD="${AVD:-parvane33}" WAIT_SECS=20 "$HERE/tgx_session_flow.sh" "$OUT/session" alice@local "$PV_PASSWORD" >"$OUT/session-flow.log" 2>&1
grep -q "сессия поднята (ядро)" "$OUT/session-flow.log" && ok "X: сессия alice поднята" || { bad "X: сессия не поднялась (см. $OUT/session-flow.log)"; stop_pid "$AP"; stop_pid "$BP"; stack_stop; finish "TGX PROTO LINK"; }

# Флаг v2 и перезапуск: журнал устройств у аккаунта уже есть → нужна линковка
echo 1 > "$OUT/flag"; ad push "$OUT/flag" /data/local/tmp/parvane-proto-v2 >/dev/null 2>&1; ad shell chmod 644 /data/local/tmp/parvane-proto-v2
ad shell rm -f /data/local/tmp/parvane-e2e-cmd
x_force_stop $PKG; ad logcat -c; ad shell am start -n "$ACT" >/dev/null 2>&1
xlog "сессия поднята" 60 && ok "X перезапущен с флагом v2" || bad "X не поднял сессию после перезапуска"
xlog "нужна линковка этого устройства" 90 && ok "X: журнал устройств уже есть — второй корень не создаётся" || bad "X: нет «нужна линковка»"
adb logcat -d | grep -aq "v2: устройство создано" && bad "X создал собственный корень" || ok "X: корень не создан"
xlog "линковка: оффер \(обязательство\) опубликован" 60 && ok "X опубликовал оффер" || bad "X без оффера"
wait_log "$AL" "линковка: грант v2 приложен" 120 && ok "alice-desktop приложила грант v2" || bad "alice-desktop не приложила грант v2"
xlog "линковка: грант v2 получен" 90 && ok "X получил грант v2" || bad "X не получил грант v2"
# T138 (SC-002, LINK-1 п. 8): «до-линковки» запечатано под одно устройство alice — X получает его строкой экспорта
xlog "линковка: история v2 перенесена \([1-9][0-9]* сообщений\)" 60 && ok "X получил историю v2-эпохи из экспорта линковки" || bad "X: история v2 не перенесена"
wait_log "$AL" "линковка: в экспорт добавлена история v2 \([1-9][0-9]* сообщений\)" 10 && ok "alice-desktop положила историю v2 в экспорт" || bad "alice-desktop: истории v2 в экспорте нет"
xlog "v2: устройство привязано грантом линковки" 60 && ok "X записан в журнал устройств" || bad "X не вступил в журнал устройств"
xlog "v2: готов" 90 && ok "X: v2-сессия готова" || bad "X: v2 не поднялся"
# T142: группы v2 новому устройству пересылает старое (ключи эпохи, сессии Megolm)
wait_log "$AL" "v2: группы пересланы новому своему устройству \(записей [1-9][0-9]*\)" 90 && ok "alice-desktop переслала группы X" || bad "alice-desktop: группы не пересланы"
xlog "группа v2 v2g:[0-9a-f]{32} появилась" 90 && ok "X: группа v2 аккаунта появилась (T142)" || bad "X: группа v2 не появилась"
xlog "журнал личного состояния подключён" 60 && ok "X: журнал личного состояния подключён (ключ пришёл грантом)" || bad "X: журнал состояния не подключён"
wait_log "$AL" "v2: новое своё устройство" 60 && ok "alice-desktop увидела новое своё устройство (T119)" || bad "alice-desktop не увидела новое устройство"

# Сообщение bob после линковки читают оба устройства alice (messenger кэширует устройства получателя 30 с)
sleep 32
stop_pid "$BP"
BP=$(start_client "$B" bob@local PARVANE_PROTO_V2=1 PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND_V2=alice@local:после-линковки-$S")
wait_log "$BL" "v2 → alice@local msg [0-9a-f-]+ \(text\)" 90 && ok "bob → alice ушло по v2" || bad "bob → alice не ушло по v2"
wait_log "$AL" "входящее msg [0-9a-f-]+ \(bob@local\): после-линковки-$S" 60 && ok "alice-desktop прочитала" || bad "alice-desktop не прочитала"
xlog "v2 ← входящее msg [0-9a-f-]+ \(text\)" 90 && ok "X (новое устройство) принял текст bob движком v2" || bad "X не принял текст после линковки"

ad logcat -d -v time > "$OUT/logcat.txt"; ad exec-out screencap -p > "$OUT/final.png"
grep -qE "FATAL EXCEPTION|E/AndroidRuntime" "$OUT/logcat.txt" && bad "X: краш (AndroidRuntime)" || ok "X без крашей"
grep -aqE "запись не открыта|E2E не удался" "$OUT/logcat.txt" "$AL" "$BL" && bad "сбои записей/E2E в логах" || ok "сбоев записей v2/E2E нет"
ad shell rm -f /data/local/tmp/parvane-proto-v2
stop_pid "$AP"; stop_pid "$BP"; stack_stop
echo "STACK_SB=$SB OUT=$OUT"
finish "TGX PROTO LINK"
