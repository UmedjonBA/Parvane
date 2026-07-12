#!/usr/bin/env bash
# Админка групп: alice(owner) через КЛИЕНТ (GroupClient→messenger) промоутит bob в
# админы, добавляет carol, удаляет carol. Проверяем через group.info: bob=admin,
# carol отсутствует; в логе alice все действия ok. Тестирует новый setrole +
# клиентский путь add/remove/setRole.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"; SHARD="$ROOT/../target/debug"
URL="nats://127.0.0.1:4222"
SB="${SCRATCH:-/tmp/parvane-gadmin}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
GNAME="АдминГруппа"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

nats-server -p 4222 >"$SB/nats.log" 2>&1 & NATS=$!; sleep 1
for s in identity messenger; do PARVANE_NATS_URL="$URL" PARVANE_DB_PATH="$SB/$s.db" PARVANE_LOG_LEVEL=warn "$SHARD/$s" >"$SB/$s.log" 2>&1 & done
PARVANE_NATS_URL="$URL" PARVANE_GATEWAY_TCP_BIND=127.0.0.1:9223 PARVANE_GATEWAY_BIND=127.0.0.1:9222 "$SHARD/gateway" >"$SB/gw.log" 2>&1 & GW=$!; sleep 2

QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='bob@local:test' "$BIN" -workdir "$B" >"$SB/b.out" 2>&1 & BP=$!
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN='alice@local:test' \
  PARVANE_AUTOGROUP="$GNAME:bob@local" \
  PARVANE_AUTOADMIN="$GNAME;admin:bob@local;add:carol@local;remove:carol@local" \
  "$BIN" -workdir "$A" >"$SB/a.out" 2>&1 & AP=$!

AL="$A/log.txt"
GID=""
for i in $(seq 1 30); do
  GID=$(grep -a "группа '$GNAME' создана" "$AL" 2>/dev/null | grep -oE '[0-9a-f-]{36}' | head -1)
  [ -n "$GID" ] && break; sleep 1
done
# Ждём последнее действие (remove carol) — стаггер до ~17с + сеть.
for i in $(seq 1 30); do grep -qa "админ-действие 'remove' над carol@local" "$AL" 2>/dev/null && break; sleep 1; done
sleep 2

echo "── alice AUTOADMIN лог ──"; grep -aE "Parvane: (AUTOADMIN|админ-действие)" "$AL" 2>/dev/null | head
# group.info через токен alice.
TOKEN=$(nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' 2>/dev/null | grep -o '{.*}' | head -1 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
INFO=$(nats --server "$URL" req group.info "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\"}" 2>/dev/null | grep -o '{.*}' | head -1)
echo "── group.info ──"; echo "$INFO"
kill "$AP" "$BP" 2>/dev/null; wait "$AP" "$BP" 2>/dev/null

[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"
grep -qa "админ-действие 'admin' над bob@local в .*: ok" "$AL" && ok "клиент: промоут bob→admin ok" || bad "промоут не сработал"
grep -qa "админ-действие 'add' над carol@local в .*: ok" "$AL" && ok "клиент: добавление carol ok" || bad "add не сработал"
grep -qa "админ-действие 'remove' над carol@local в .*: ok" "$AL" && ok "клиент: удаление carol ok" || bad "remove не сработал"
# Итоговое состояние по group.info.
echo "$INFO" | python3 -c '
import sys,json
j=json.load(sys.stdin)
gs=j.get("groups",[])
ms={m["address"]:m["role"] for m in (gs[0].get("members",[]) if gs else [])}
bob=ms.get("bob@local"); carol="carol@local" in ms
print("BOBROLE="+str(bob)); print("CAROL="+str(carol))
' > "$SB/state.txt" 2>/dev/null
BOBROLE=$(grep BOBROLE "$SB/state.txt" | cut -d= -f2); CAROL=$(grep CAROL "$SB/state.txt" | cut -d= -f2)
[ "$BOBROLE" = "admin" ] && ok "group.info: bob = admin" || bad "bob не admin (роль=$BOBROLE)"
[ "$CAROL" = "False" ] && ok "group.info: carol удалена (добавлена и удалена)" || bad "carol всё ещё в группе ($CAROL)"

kill "$GW" "$NATS" 2>/dev/null; pkill -x identity 2>/dev/null; pkill -x messenger 2>/dev/null; pkill -9 -x Telegram 2>/dev/null
[ "$RC" -eq 0 ] && printf '\033[32mАДМИНКА ГРУПП: OK\033[0m\n' || printf '\033[31mАДМИНКА ГРУПП: ПРОВАЛЫ\033[0m\n'
exit "$RC"
