#!/usr/bin/env bash
# Фаза 3 — РОТАЦИЯ ключа группы при удалении участника (forward secrecy).
# alice(owner)+bob+carol. alice шлёт msg1 (оба читают). carol удаляют. alice, увидев
# это (RefreshGroups), ротирует свою Megolm-сессию и шлёт msg2 новым ключом.
# Проверяем:
#   1) до удаления: и bob, и carol расшифровали msg1;
#   2) alice заметила выбытие и ротировала ключ (лог);
#   3) ПОСЛЕ ротации: bob расшифровал msg2 (re-key оставшемуся сработал);
#   4) carol НЕ получила msg2 (удалена: и сервером не фанится, и ключа новой сессии нет);
#   5) плейнтекста msg2 нет в messenger.db.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"; SHARD="$ROOT/../target/debug"
URL="nats://127.0.0.1:4222"
SB="${SCRATCH:-/tmp/parvane-grprot}"; rm -rf "$SB"; mkdir -p "$SB"
STAMP="$(date +%s)"; GNAME="РотГруппа"
M1="до-удаления-$STAMP"; M2="после-ротации-$STAMP"
A="$SB/alice/td"; B="$SB/bob/td"; C="$SB/carol/td"; mkdir -p "$A" "$B" "$C"
AL="$A/log.txt"; BL="$B/log.txt"; CL="$C/log.txt"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!; sleep 1
for s in identity messenger; do
  PARVANE_NATS_URL="$URL" PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 &
done
PARVANE_NATS_URL="$URL" PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 \
  PARVANE_LOG_LEVEL=warn "$SHARD/gateway" >"$SB/gw.log" 2>&1 & GW=$!; sleep 2

# bob и carol первыми (успеют опубликовать prekeys + подхватить группу).
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' \
  "$BIN" -workdir "$B" >"$B/out.log" 2>&1 & BP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='carol@local:test' \
  "$BIN" -workdir "$C" >"$C/out.log" 2>&1 & CP=$!
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' \
  PARVANE_AUTOGROUP="$GNAME:bob@local,carol@local" \
  PARVANE_AUTOGROUPSEND="$GNAME:$M1" PARVANE_AUTOGROUPSEND2="$GNAME:$M2" \
  "$BIN" -workdir "$A" >"$A/out.log" 2>&1 & AP=$!

# msg1 у обоих (до удаления).
for i in $(seq 1 40); do
  grep -qa "групповое .* от alice@local: $M1" "$BL" 2>/dev/null \
    && grep -qa "групповое .* от alice@local: $M1" "$CL" 2>/dev/null && break
  sleep 1
done
grep -qa "групповое .* от alice@local: $M1" "$BL" && ok "bob расшифровал msg1 (до удаления)" || bad "bob не получил msg1"
grep -qa "групповое .* от alice@local: $M1" "$CL" && ok "carol расшифровал msg1 (до удаления)" || bad "carol не получил msg1"

GID=$(grep -a "группа '$GNAME' создана" "$AL" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"

# Удаляем carol (owner alice): берём её токен и шлём group.removemember.
TOKRESP=$(nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' 2>/dev/null | grep -o '{.*}' | head -1)
TOKEN=$(printf '%s' "$TOKRESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -n "$TOKEN" ] && [ -n "$GID" ]; then
  nats --server "$URL" req group.removemember \
    "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\",\"member\":\"carol@local\"}" >/dev/null 2>&1
  ok "carol удалена из группы (group.removemember)"
else
  bad "не удалось удалить carol (токен/GID пусты)"
fi

# Ждём ротацию у alice (RefreshGroups заметит выбытие) и msg2 у bob.
for i in $(seq 1 45); do
  grep -qa "ротация ключа группы" "$AL" 2>/dev/null \
    && grep -qa "групповое .* от alice@local: $M2" "$BL" 2>/dev/null && break
  sleep 1
done
sleep 2
kill "$AP" "$BP" "$CP" 2>/dev/null; wait "$AP" "$BP" "$CP" 2>/dev/null

echo "── ALICE ──"; grep -aE "Parvane: (участник выбыл|ротация|AUTOGROUPSEND2?|отправлено)" "$AL" 2>/dev/null | head
echo "── BOB ──"; grep -aE "групповое .* (: $M1|: $M2)" "$BL" 2>/dev/null | head
echo "── CAROL ──"; grep -aE "групповое .* (: $M1|: $M2)" "$CL" 2>/dev/null | head
echo "──────────"

grep -qa "ротация ключа группы" "$AL" && ok "alice ротировала ключ после выбытия carol" || bad "ротации не было"
grep -qa "групповое .* от alice@local: $M2" "$BL" && ok "bob расшифровал msg2 ПОСЛЕ ротации (re-key ok)" || bad "bob НЕ расшифровал msg2 — re-key сломан!"
if grep -qa "групповое .* от alice@local: $M2" "$CL"; then
  bad "carol ПОЛУЧИЛА msg2 после удаления — forward secrecy НАРУШЕНА!"
else
  ok "carol НЕ получила msg2 (удалена: нет фана + нет нового ключа)"
fi
if grep -qa "$M2" "$SB/messenger.db" 2>/dev/null; then
  bad "плейнтекст msg2 в messenger.db"
else
  ok "плейнтекст msg2 отсутствует в messenger.db"
fi

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null
[ "$RC" -eq 0 ] && printf '\033[32mРОТАЦИЯ ГРУПП: OK\033[0m\n' || printf '\033[31mРОТАЦИЯ ГРУПП: ПРОВАЛЫ\033[0m\n'
exit "$RC"
