#!/usr/bin/env bash
# Parvane — приём/отправка МЕДИА между двумя РЕАЛЬНЫМИ экземплярами форка
# (Фаза 4a+4b). alice-форк шлёт файл bob-форку штатным путём tdesktop; bob-форк
# принимает его через sync → скачивает блоб из cloud → инъецирует медиа-
# сообщение в Data::Session. Проверяем:
#   1) alice отправила медиа в шину (лог "медиа отправлено", есть file_id);
#   2) bob скачал и инъецировал медиа (лог "получено медиа от alice");
#   3) у bob диалог alice в списке (медиа-диалог … в списке=1);
#   4) скачанный на диск блоб побайтово равен исходному файлу;
#   5) ни в одном логе нет фатальных ошибок / ошибок скачивания.
#
# Требует запущенные nats + identity + messenger + cloud и собранный бинарь.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/build-probe/bin/Telegram"
URL="${PARVANE_NATS_URL:-nats://127.0.0.1:4222}"
NATS="${NATS_BIN:-$HOME/.local/bin/nats}"
MEDIA_DIR="${TMPDIR:-/tmp}/parvane-media"
A_WD="$(mktemp -d /tmp/pv-2m-alice.XXXXXX)"
B_WD="$(mktemp -d /tmp/pv-2m-bob.XXXXXX)"
A_LOG="$A_WD/td/log.txt"; B_LOG="$B_WD/td/log.txt"
STAMP="$(date +%s)"
SRC="$A_WD/blob.bin"
RC=0

ok()  { printf '\033[32mok  \033[0m %s\n' "$*"; }
bad() { printf '\033[31mFAIL\033[0m %s\n' "$*"; RC=1; }

[ -x "$BIN" ] || { echo "нет бинаря $BIN — сначала собери"; exit 2; }
"$NATS" --server "$URL" req identity.token.issue '{"user":"alice@local","password":"test"}' \
    >/dev/null 2>&1 || { echo "identity не отвечает — запусти шарды"; exit 2; }

# Бинарь с нулевым/0xff байтами — проверяем целостность.
printf 'RECV MEDIA 2INST \x00\xff\x01 %s' "$STAMP" > "$SRC"
SZ=$(stat -c%s "$SRC")
echo "файл: $SZ байт; stamp=$STAMP"

# bob слушает; alice логинится и шлёт файл.
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN='bob@local:test' \
  "$BIN" -workdir "$B_WD/td" >"$B_WD/out.log" 2>&1 &
BPID=$!
sleep 3
QT_QPA_PLATFORM=offscreen PARVANE_NATS_URL="$URL" PARVANE_AUTOLOGIN='alice@local:test' \
  PARVANE_AUTOSENDFILE="bob@local:$SRC" \
  "$BIN" -workdir "$A_WD/td" >"$A_WD/out.log" 2>&1 &
APID=$!

# Извлекаем file_id из лога alice, ждём приёма у bob именно этого file_id.
FID=""
for i in $(seq 1 30); do
    [ -z "$FID" ] && FID=$(grep "Parvane: медиа отправлено" "$A_LOG" 2>/dev/null \
        | tail -1 | sed -n 's/.*(file \([0-9a-f-]\+\).*/\1/p')
    [ -n "$FID" ] && grep -q "получено медиа.*alice@local:.*${FID}" "$B_LOG" 2>/dev/null && break
    sleep 1
done
sleep 2
kill "$APID" "$BPID" 2>/dev/null; wait "$APID" "$BPID" 2>/dev/null

echo "── ALICE (отправка) ──"; grep -iE "Parvane: (autosendfile|медиа отправлено)" "$A_LOG" 2>/dev/null || echo "(пусто)"
echo "── BOB (приём) ──"; grep -iE "Parvane: (получено медиа|медиа-диалог)" "$B_LOG" 2>/dev/null | grep "$FID" || echo "(пусто)"
echo "──────────────────"

grep -q "Parvane: медиа отправлено.*$FID" "$A_LOG" 2>/dev/null && ok "alice отправила медиа (file ${FID:0:8}…)" || bad "alice не отправила медиа"
grep -q "получено медиа.*alice@local:.*$FID" "$B_LOG" 2>/dev/null && ok "bob принял и инъецировал медиа" || bad "bob не принял медиа"
grep -q "медиа-диалог alice@local — в списке=1" "$B_LOG" 2>/dev/null && ok "у bob диалог alice в списке" || bad "у bob нет медиа-диалога"

# Целостность: файл, который bob записал на диск, == исходному.
GOT=$(ls -t "$MEDIA_DIR/${FID}_"* 2>/dev/null | head -1)
if [ -n "$GOT" ] && cmp -s "$SRC" "$GOT"; then
    ok "скачанный блоб побайтово равен исходному ($SZ байт)"
else
    bad "блоб на диске не совпал (got=$GOT)"
fi

grep -qiE "Fatal|Unexpected in |ошибка скачивания медиа|не записать медиа" "$A_LOG" "$B_LOG" 2>/dev/null \
    && bad "ошибка в логе" || ok "без фатальных ошибок"

rm -rf "$A_WD" "$B_WD"
[ "$RC" -eq 0 ] && printf '\033[32mМЕДИА 2 ЭКЗЕМПЛЯРА: OK\033[0m\n' || printf '\033[31mМЕДИА 2 ЭКЗЕМПЛЯРА: ЕСТЬ ПРОВАЛЫ\033[0m\n'
exit "$RC"
