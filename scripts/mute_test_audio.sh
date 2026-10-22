# Тишина на время тестов (подключается через `.`): звук всех дочерних процессов прогона — desktop-клиентов,
# Chromium из Playwright, эмулятора — уходит в «немой» сток PulseAudio/PipeWire `parvane_mute` вместо колонок.
# Сток системы по умолчанию не меняется; без pactl (CI, без звукового сервера) — ничего не делает.
# Отключить: PARVANE_TEST_AUDIO=1.
if [ "${PARVANE_TEST_AUDIO:-0}" != 1 ] && command -v pactl >/dev/null 2>&1; then
  if ! pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -qx parvane_mute; then
    __pv_default_sink=$(pactl get-default-sink 2>/dev/null || true)
    pactl load-module module-null-sink sink_name=parvane_mute \
      sink_properties=device.description=parvane-test-mute >/dev/null 2>&1 || true
    # новый сток не должен перехватить звук пользователя
    if [ -n "$__pv_default_sink" ] && [ "$(pactl get-default-sink 2>/dev/null || true)" != "$__pv_default_sink" ]; then
      pactl set-default-sink "$__pv_default_sink" >/dev/null 2>&1 || true
    fi
    unset __pv_default_sink
  fi
  if pactl list short sinks 2>/dev/null | awk '{print $2}' | grep -qx parvane_mute; then
    export PULSE_SINK=parvane_mute
    # ALSA-клиенты PipeWire (pipewire-alsa) берут цель отсюда
    export PIPEWIRE_NODE=parvane_mute
  fi
fi
