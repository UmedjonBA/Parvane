#!/usr/bin/env bash
# Сторож тишины на время прогона: раз в 2 с переводит в немой сток `parvane_mute` звук ТЕСТОВЫХ процессов (tdesktop
# стендов, Chromium/headless Playwright, эмулятор Android, node сценариев), даже если процесс не взял PULSE_SINK.
# Программы пользователя (его Firefox, проигрыватели) не трогаются: отбор — по исполняемому файлу и пути.
#   scripts/mute_test_audio_watch.sh <pid-владельца>   — работает, пока жив процесс-владелец (раннер)
set -u
OWNER="${1:-$PPID}"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mute_test_audio.sh"
[ "${PULSE_SINK:-}" = parvane_mute ] || exit 0
export MUTE_SINK_ID="$(pactl list short sinks 2>/dev/null | awk '$2=="parvane_mute"{print $1}')"
while kill -0 "$OWNER" 2>/dev/null; do
  pactl -f json list sink-inputs 2>/dev/null | python3 -c '
import json, os, sys
try:
    items = json.load(sys.stdin)
except Exception:
    sys.exit(0)
def cmdline(pid):
    try:
        return open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace")
    except Exception:
        return ""
for s in items:
    p = s.get("properties", {})
    pid = p.get("application.process.id") or ""
    cmd = cmdline(pid)
    test = ("build-probe/bin/Telegram" in cmd or "ms-playwright" in cmd or "headless_shell" in cmd
            or "qemu-system" in cmd or "/tmp/pv-" in cmd or "parvane-web-e2e" in cmd)
    if test and str(s.get("sink")) != os.environ.get("MUTE_SINK_ID", ""):
        print(s["index"])
' | while read -r idx; do pactl move-sink-input "$idx" parvane_mute >/dev/null 2>&1; done
  sleep 2
done
