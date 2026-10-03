#!/usr/bin/env bash
# Админка групп: alice(owner) через КЛИЕНТ (GroupClient→messenger) промоутит bob в
# админы, добавляет carol, удаляет carol. Проверяем через group.info: bob=admin,
# carol отсутствует; в логе alice все действия ok. Тестирует новый setrole +
# клиентский путь add/remove/setRole.
# Протокол v2 (по умолчанию, T135): те же действия — записи журнала группы;
# состояние сверяется по журналу участника bob (его роль, число участников), а
# carol поднимается заранее (в группу v2 добавляется только пользователь на v2).
# PV_PROTO=v1 — прежний путь с проверкой через group.info шарда.
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
URL="nats://127.0.0.1:4222"
SB="${SCRATCH:-/tmp/parvane-gadmin}"; rm -rf "$SB"; mkdir -p "$SB"
A="$SB/alice/td"; B="$SB/bob/td"; mkdir -p "$A" "$B"
GNAME="АдминГруппа"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

stack_up "$SB"

QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$B" >"$SB/b.out" 2>&1 & BP=$!
CP=""
if is_v2; then
  C="$SB/carol/td"; mkdir -p "$C"
  QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="carol@local:${PV_PASSWORD:-test-pass-2026}" "$BIN" -workdir "$C" >"$SB/c.out" 2>&1 & CP=$!
  wait_log "$C/log.txt" "v2: готов" 60 || bad "carol: v2 не поднялся"
fi
sleep 2
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" \
  PARVANE_AUTOGROUP="$GNAME:bob@local" \
  PARVANE_AUTOADMIN="$GNAME;admin:bob@local;add:carol@local;remove:carol@local" \
  "$BIN" -workdir "$A" >"$SB/a.out" 2>&1 & AP=$!

AL="$A/log.txt"
GID=""
for i in $(seq 1 30); do
  GID=$(group_gid "$AL" "$GNAME")
  [ -n "$GID" ] && break; sleep 1
done
# Ждём последнее действие (remove carol) — стаггер до ~17с + сеть.
for i in $(seq 1 30); do grep -qa "админ-действие 'remove' над carol@local" "$AL" 2>/dev/null && break; sleep 1; done
sleep 2

echo "── alice AUTOADMIN лог ──"; grep -aE "Parvane: (AUTOADMIN|админ-действие)" "$AL" 2>/dev/null | head
# group.info через токен alice.
TOKEN=$(nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"'"${PV_PASSWORD:-test-pass-2026}"'"}' 2>/dev/null | grep -o '{.*}' | head -1 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
INFO=$(nats --server "$URL" req group.info "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\"}" 2>/dev/null | grep -o '{.*}' | head -1)
echo "── group.info ──"; echo "$INFO"
is_v2 && sleep 3 # bob дочитывает журнал группы после последней записи
kill "$AP" "$BP" $CP 2>/dev/null; wait "$AP" "$BP" $CP 2>/dev/null

[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"
grep -qaE "админ-действие 'admin' над bob@local в .*(: ok|→ ok)" "$AL" && ok "клиент: промоут bob→admin ok" || bad "промоут не сработал"
grep -qaE "админ-действие 'add' над carol@local в .*(: ok|→ ok)" "$AL" && ok "клиент: добавление carol ok" || bad "add не сработал"
grep -qaE "админ-действие 'remove' над carol@local в .*(: ok|→ ok)" "$AL" && ok "клиент: удаление carol ok" || bad "remove не сработал"
if is_v2; then
  # Состояние — по журналу группы глазами bob: он админ, участников снова двое
  group_line "$B/log.txt" "$GID" | grep -q "role=admin" && ok "журнал группы у bob: bob = admin" \
    || bad "bob не admin ($(group_line "$B/log.txt" "$GID" | grep -o 'role=[a-z]*'))"
  grep -a "v2: группа $GID обновлена" "$B/log.txt" | grep -q "участников 3" && ok "журнал группы у bob: carol была добавлена" \
    || bad "bob не видел добавления carol"
  grep -a "v2: группа $GID обновлена" "$B/log.txt" | tail -1 | grep -q "участников 2" && ok "журнал группы у bob: carol удалена" \
    || bad "carol всё ещё в группе по журналу bob"
  grep -qa "группа $GID снята" "$C/log.txt" && ok "carol: группа снята после исключения" || bad "carol: группа не снята"
  clients_kill "$SB"; stack_stop
  [ "$RC" -eq 0 ] && printf '\033[32mАДМИНКА ГРУПП: OK\033[0m\n' || printf '\033[31mАДМИНКА ГРУПП: ПРОВАЛЫ\033[0m\n'
  exit "$RC"
fi
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

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mАДМИНКА ГРУПП: OK\033[0m\n' || printf '\033[31mАДМИНКА ГРУПП: ПРОВАЛЫ\033[0m\n'
exit "$RC"
