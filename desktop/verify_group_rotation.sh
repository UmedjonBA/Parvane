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
# Протокол v2 (по умолчанию, T135): carol исключает сама alice записью журнала
# группы (хук AUTOADMIN remove), «ротация» — новая эпоха группы; при PV_PROTO=v1
# — прежний путь (group.removemember шарду и Megolm-ротация).
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify_lib.sh"
URL="nats://127.0.0.1:4222"
SB="${SCRATCH:-/tmp/parvane-grprot}"; rm -rf "$SB"; mkdir -p "$SB"
STAMP="$(date +%s)"; GNAME="РотГруппа"
M1="до-удаления-$STAMP"; M2="после-ротации-$STAMP"
A="$SB/alice/td"; B="$SB/bob/td"; C="$SB/carol/td"; mkdir -p "$A" "$B" "$C"
AL="$A/log.txt"; BL="$B/log.txt"; CL="$C/log.txt"
RC=0
ok(){ printf '\033[32mok  \033[0m %s\n' "$*"; }; bad(){ printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }
[ -x "$BIN" ] || { echo "нет бинаря $BIN"; exit 2; }

stack_up "$SB"

# bob и carol первыми (успеют опубликовать prekeys + подхватить группу).
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="bob@local:${PV_PASSWORD:-test-pass-2026}" \
  "$BIN" -workdir "$B" >"$B/out.log" 2>&1 & BP=$!
QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="carol@local:${PV_PASSWORD:-test-pass-2026}" \
  "$BIN" -workdir "$C" >"$C/out.log" 2>&1 & CP=$!
sleep 2
# v2: исключение — через ~11 с после входа (после msg1 на 9-й секунде), msg2 — на 24-й
EXTRA=(); is_v2 && EXTRA=("PARVANE_AUTOADMIN=$GNAME;remove:carol@local")
env QT_QPA_PLATFORM=offscreen PARVANE_GATEWAY_URL='127.0.0.1:9223' PARVANE_AUTOLOGIN="alice@local:${PV_PASSWORD:-test-pass-2026}" \
  PARVANE_AUTOGROUP="$GNAME:bob@local,carol@local" \
  PARVANE_AUTOGROUPSEND="$GNAME:$M1" PARVANE_AUTOGROUPSEND2="$GNAME:$M2" "${EXTRA[@]}" \
  "$BIN" -workdir "$A" >"$A/out.log" 2>&1 & AP=$!

# msg1 у обоих (до удаления).
for i in $(seq 1 40); do
  grep -qa "групповое .* от alice@local: $M1" "$BL" 2>/dev/null \
    && grep -qa "групповое .* от alice@local: $M1" "$CL" 2>/dev/null && break
  sleep 1
done
grep -qa "групповое .* от alice@local: $M1" "$BL" && ok "bob расшифровал msg1 (до удаления)" || bad "bob не получил msg1"
grep -qa "групповое .* от alice@local: $M1" "$CL" && ok "carol расшифровал msg1 (до удаления)" || bad "carol не получил msg1"

GID=$(group_gid "$AL" "$GNAME")
[ -n "$GID" ] && ok "группа создана ($GID)" || bad "GID не найден"

if is_v2; then
  ROTATED="v2: новая эпоха группы ${GID#v2g:}: [2-9]"
  for i in $(seq 1 30); do grep -qa "админ-действие 'remove' над carol@local в .* → ok" "$AL" 2>/dev/null && break; sleep 1; done
  grep -qa "админ-действие 'remove' над carol@local в .* → ok" "$AL" \
    && ok "carol исключена записью журнала группы (v2)" || bad "не удалось исключить carol (v2)"
else
ROTATED="ротация ключа группы"
# Удаляем carol (owner alice): берём её токен и шлём group.removemember.
TOKRESP=$(nats --server "$URL" req identity.token.issue '{"user":"alice@local","password":"'"${PV_PASSWORD:-test-pass-2026}"'"}' 2>/dev/null | grep -o '{.*}' | head -1)
TOKEN=$(printf '%s' "$TOKRESP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))' 2>/dev/null)
if [ -n "$TOKEN" ] && [ -n "$GID" ]; then
  nats --server "$URL" req group.removemember \
    "{\"token\":\"$TOKEN\",\"group_id\":\"$GID\",\"member\":\"carol@local\"}" >/dev/null 2>&1
  ok "carol удалена из группы (group.removemember)"
else
  bad "не удалось удалить carol (токен/GID пусты)"
fi
fi

# Ждём ротацию у alice (RefreshGroups заметит выбытие) и msg2 у bob.
for i in $(seq 1 45); do
  grep -qaE "$ROTATED" "$AL" 2>/dev/null \
    && grep -qa "групповое .* от alice@local: $M2" "$BL" 2>/dev/null && break
  sleep 1
done
sleep 2
kill "$AP" "$BP" "$CP" 2>/dev/null; wait "$AP" "$BP" "$CP" 2>/dev/null

echo "── ALICE ──"; grep -aE "Parvane: (участник выбыл|ротация|AUTOGROUPSEND2?|отправлено|v2: новая эпоха|админ-действие)" "$AL" 2>/dev/null | head
echo "── BOB ──"; grep -aE "групповое .* (: $M1|: $M2)" "$BL" 2>/dev/null | head
echo "── CAROL ──"; grep -aE "групповое .* (: $M1|: $M2)" "$CL" 2>/dev/null | head
echo "──────────"

grep -qaE "$ROTATED" "$AL" && ok "alice ротировала ключ после выбытия carol" || bad "ротации не было"
grep -qa "групповое .* от alice@local: $M2" "$BL" && ok "bob расшифровал msg2 ПОСЛЕ ротации (re-key ok)" || bad "bob НЕ расшифровал msg2 — re-key сломан!"
if grep -qa "групповое .* от alice@local: $M2" "$CL"; then
  bad "carol ПОЛУЧИЛА msg2 после удаления — forward secrecy НАРУШЕНА!"
else
  ok "carol НЕ получила msg2 (удалена: нет фана + нет нового ключа)"
fi
if grep -qa "$M2" "$SB"/messenger.db* 2>/dev/null; then
  bad "плейнтекст msg2 в БД messenger"
else
  ok "плейнтекст msg2 отсутствует в БД messenger"
fi

clients_kill "$SB"; stack_stop
[ "$RC" -eq 0 ] && printf '\033[32mРОТАЦИЯ ГРУПП: OK\033[0m\n' || printf '\033[31mРОТАЦИЯ ГРУПП: ПРОВАЛЫ\033[0m\n'
exit "$RC"
