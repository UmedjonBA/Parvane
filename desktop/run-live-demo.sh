#!/usr/bin/env bash
# Живой демо-прогон Parvane: поднимает бэкенд + два экземпляра форка (alice/bob)
# на твоём дисплее, alice сразу звонит bob (bob авто-принимает) — увидишь НАТИВНЫЙ
# экран звонка. Запускать в СВОЁМ терминале (не через ассистента — его процессы
# гибнут при возврате команды).
#
#   bash desktop/run-live-demo.sh
#
# Погасить всё потом:  bash desktop/run-live-demo.sh stop
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
BIN="$PWD/desktop/build-probe/bin/Telegram"
W="$HOME/parvane-demo"

stop() {
	pkill -9 -f 'bin/Telegram -workdir' 2>/dev/null
	for p in $(pgrep -x 'identity|call|messenger|cloud|nats-server' 2>/dev/null); do
		kill -9 "$p" 2>/dev/null
	done
	echo "остановлено"
}
[ "${1:-}" = "stop" ] && { stop; exit 0; }

stop; sleep 2
rm -rf "$W"; mkdir -p "$W"/{alice,bob}

# Бэкенд (чистые БД — важно, чтобы call-ключи не были устаревшими).
setsid nohup nats-server -p 4222 >"$W/nats.log" 2>&1 </dev/null & disown
sleep 2
for s in identity messenger cloud call; do
	setsid nohup env PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_DB_PATH="$W/$s.db" \
		./target/debug/$s >"$W/$s.log" 2>&1 </dev/null & disown
done
sleep 3
echo "бэкенд: $(pgrep -x nats-server|head -1) / identity $(pgrep -x identity|head -1) / call $(pgrep -x call|head -1)"

ce="PARVANE_NATS_URL=nats://127.0.0.1:4222 PARVANE_REAL_MEDIA=1 QT_OPENGL=software LIBGL_ALWAYS_SOFTWARE=1"
# bob — авто-приём входящего.
setsid nohup env $ce PARVANE_AUTOLOGIN='bob@local:test' PARVANE_AUTOACCEPT=1 \
	"$BIN" -workdir "$W/bob" >"$W/bob.out" 2>&1 & disown
sleep 6
# alice — сразу звонит bob (аудио). Замени на 'bob@local:video' для видеозвонка.
setsid nohup env $ce PARVANE_AUTOLOGIN='alice@local:test' PARVANE_AUTOCALL='bob@local' \
	"$BIN" -workdir "$W/alice" >"$W/alice.out" 2>&1 & disown

echo "Запущено. Через несколько секунд у alice появится НАТИВНЫЙ экран звонка."
echo "Логи: $W/alice/log.txt , $W/bob/log.txt"
echo "Без звонка (просто два окна): убери PARVANE_AUTOCALL/PARVANE_AUTOACCEPT."
