#!/usr/bin/env bash
# Живой демо-прогон Parvane: бэкенд + два экземпляра форка (alice/bob) + звонок.
# Каждый процесс — в своём systemd --user scope, чтобы пережить (иначе гибнут).
#
#   bash desktop/run-live-demo.sh          # поднять
#   bash desktop/run-live-demo.sh video    # то же, но видеозвонок
#   bash desktop/run-live-demo.sh stop      # погасить
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
BIN="$PWD/desktop/build-probe/bin/Telegram"
W="$HOME/parvane-demo"
MODE="${1:-audio}"

run() { systemd-run --user --scope -u "pv-$1" env "${@:2}" >/dev/null 2>&1 & }

stop() {
	for u in pv-alice pv-bob pv-nats pv-identity pv-messenger pv-cloud pv-call; do
		systemctl --user stop "$u.scope" 2>/dev/null
	done
	pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
	pkill -9 -x nats-server identity messenger cloud call 2>/dev/null
	echo "остановлено"
}
[ "$MODE" = "stop" ] && { stop; exit 0; }

stop; sleep 2
rm -rf "$W"; mkdir -p "$W"/{alice,bob}

# Бэкенд (чистые БД — важно для стабильных call-ключей).
run nats nats-server -p 4222
sleep 2
for s in identity messenger cloud call; do
	run "$s" PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$W/$s.db" "$PWD/target/debug/$s"
done
sleep 3
echo "бэкенд на 4222: $(ss -ltn 2>/dev/null | grep -c ':4222')"

CE=(DISPLAY=:0 WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/user/1000
	QT_OPENGL=software LIBGL_ALWAYS_SOFTWARE=1
	PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_REAL_MEDIA=1)
CALLSPEC='bob@local'; [ "$MODE" = "video" ] && CALLSPEC='bob@local:video'

run bob "${CE[@]}" PARVANE_AUTOLOGIN='bob@local:test' PARVANE_AUTOACCEPT=1 \
	"$BIN" -workdir "$W/bob"
sleep 6
run alice "${CE[@]}" PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOCALL="$CALLSPEC" \
	"$BIN" -workdir "$W/alice"

echo "Запущено. Через ~10с alice позвонит bob → нативный экран звонка."
echo "Отбой в окне звонка НЕ должен закрывать главное окно."
echo "Логи: $W/alice/log.txt , $W/bob/log.txt"
