#!/usr/bin/env bash
# Работа в фоне (spec 031, US4) после tgx_session_flow.sh (его стек и сессия X alice):
#   1) служба связи «Parvane на связи» поднята (распространителя UnifiedPush в эмуляторе нет);
#   2) X свёрнут, bob пишет — уведомление в шторке (уведомления X из шва, Notifications.kt);
#   3) UnifiedPush: адрес тестового распространителя (приёмник на стенде, http://127.0.0.1:<порт>; шард push в
#      тестовом режиме — сборка `--features insecure-test-transport` + PARVANE_PUSH_INSECURE_HTTP=1) уходит серверу
#      видом WEB_PUSH;
#   4) приложение остановлено, bob пишет → шард push сам шлёт пробуждение на адрес распространителя (≤ 30 с),
#      распространитель передаёт его приложению → служба поднимает сессию → входящее и уведомление.
#   ./tgx_push_flow.sh [OUT_DIR]
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-/tmp/pv-tgx-push}"; mkdir -p "$OUT"
. "$HERE/../desktop/verify_lib.sh"
. "$HERE/tgx_lib.sh"
tgx_env
TGX_LOG="$OUT/logcat.txt"
SB=$(ls -td /tmp/pv-tgx.* | head -1); B="$SB/bob"
notif() { a shell dumpsys notification --noredact 2>/dev/null | tr -d '\r'; }
tgx_stop; tgx_start
tgx_logwait "v2: готов" 90 && ok "X: сессия поднята" || bad "X: сессии нет"
sleep 5
notif > "$OUT/notif-1.txt"
grep -q "Parvane на связи\|Parvane is connected" "$OUT/notif-1.txt" && ok "служба связи на переднем плане" || bad "нет уведомления службы связи"
# 2) свёрнуто — входящее → уведомление
a shell input keyevent 3; sleep 2
S="fon-$(date +%s)"; tgx_mark
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:$S")
tgx_logwait "v2 ← входящее msg" 90 && ok "свёрнутый X получил сообщение" || bad "свёрнутый X не получил сообщение"
sleep 4; notif > "$OUT/notif-2.txt"
grep -q "$S" "$OUT/notif-2.txt" && ok "уведомление о сообщении в шторке" || bad "уведомления о сообщении нет"
stop_pid "$BP"
# 3) UnifiedPush: тестовый распространитель на стенде — приёмник POST шарда push
UP_PORT="${PV_UP_PORT:-9400}"; UP_LOG="$OUT/distributor.log"; : > "$UP_LOG"
python3 -c '
import http.server, sys, time
log = open(sys.argv[2], "a", buffering=1)
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n)
        log.write("%d POST %s %d байт\n" % (time.time(), self.path, n))
        self.send_response(201); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$UP_PORT" "$UP_LOG" & UPP=$!
# шард push того же стека — в тестовом режиме (адрес распространителя на loopback)
PUSH_PID=$(for p in $(pgrep -x push); do grep -qa "PARVANE_DB_PATH=$SB/push.db" "/proc/$p/environ" 2>/dev/null && echo "$p"; done | head -1)
[ -n "$PUSH_PID" ] && kill "$PUSH_PID" 2>/dev/null; sleep 1
: >> "$SB/push.log"; PUSH_MARK=$(wc -l < "$SB/push.log")
shard_start push PARVANE_PUSH_INSECURE_HTTP=1
for _ in $(seq 1 60); do tail -n "+$((PUSH_MARK + 1))" "$SB/push.log" | grep -qa "Push шард запущен" && break; sleep 1; done
EP="http://127.0.0.1:$UP_PORT/up/pvE2E$(date +%s)"; tgx_mark
a shell am broadcast -a org.unifiedpush.android.connector.NEW_ENDPOINT -n "$TGX_PKG/org.thunderdog.challegram.parvane.ParvaneUnifiedPushReceiver" \
  --es token parvane-e2e --es endpoint "$EP" >/dev/null 2>&1
tgx_logwait "UnifiedPush: адрес зарегистрирован" 30 && ok "адрес UnifiedPush принят сервером (WEB_PUSH)" || bad "адрес UnifiedPush не зарегистрирован ($(grep -o 'UnifiedPush: адрес.*' "$TGX_LOG" | tail -1))"
# 4) остановлено → пробуждение → сессия → входящее
a shell am force-stop "$TGX_PKG"; sleep 3
S2="probuzhdenie-$(date +%s)"
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:$S2")
wait_log "$B/td/log.txt" "autosend → alice@local" 60 && ok "bob отправил, пока X остановлен" || bad "bob не отправил"
# распространитель: пробуждение от шарда push пришло на его адрес — передаём приложению
T0=$(date +%s); GOT=""
for _ in $(seq 1 30); do grep -q "POST /up/" "$UP_LOG" && { GOT=1; break; }; sleep 1; done
[ -n "$GOT" ] && ok "шард push прислал пробуждение распространителю за $(( $(date +%s) - T0 )) с (≤ 30 с)" \
  || bad "пробуждения от шарда push нет (см. $UP_LOG, $SB/push.log)"
tgx_mark
a shell am broadcast -f 0x20 -a org.unifiedpush.android.connector.MESSAGE -n "$TGX_PKG/org.thunderdog.challegram.parvane.ParvaneUnifiedPushReceiver" \
  --es token parvane-e2e >/dev/null 2>&1
tgx_logwait "ParvaneBackground.*пробуждение" 30 && ok "пробуждение принято" || bad "пробуждение не принято"
tgx_logwait "v2 ← входящее msg" 90 && ok "после пробуждения сообщение получено" || bad "после пробуждения сообщения нет"
sleep 4; notif > "$OUT/notif-3.txt"
grep -q "$S2" "$OUT/notif-3.txt" && ok "уведомление после пробуждения" || bad "уведомления после пробуждения нет"
stop_pid "$BP"
# сжатие пробуждений: серия сообщений подряд — одно пробуждение (окно схлопывания шарда push — 30 с)
a shell am force-stop "$TGX_PKG"; sleep 32
N0=$(grep -c "POST /up/" "$UP_LOG")
# один запуск bob — текст и геопозиция подряд (две записи в инбокс X за секунды)
BP=$(start_client "$B" bob@local PARVANE_NO_LINK_OFFER=1 "PARVANE_AUTOSEND=alice@local:seriya-$S2" "PARVANE_AUTOLOCATION=alice@local:55.75,37.61")
wait_log "$B/td/log.txt" "autosend → alice@local" 60 || bad "bob: серия не отправлена"
sleep 10; N1=$(grep -c "POST /up/" "$UP_LOG")
[ $((N1 - N0)) -eq 1 ] && ok "серия из двух сообщений — одно пробуждение (схлопнуто)" || bad "пробуждений на серию из двух: $((N1 - N0)) (ждали 1)"
stop_pid "$BP"
kill "$UPP" 2>/dev/null
tgx_no_crash
kill "$TGX_LCP" 2>/dev/null
finish "TGX PUSH"
