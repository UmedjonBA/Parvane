// Parvane fork: реальный медиа-движок звонка — parvane::MediaBackend поверх
// webrtc::PeerConnection (tg_owt). Заменяет StubMediaBackend, когда нужен живой
// звук (Э3-b). Все webrtc-заголовки спрятаны в .cpp — здесь только фабрика.
// Аудио-only на старте; ICE-серверы (STUN/TURN) — параметром позже.
#pragma once

#include <memory>
#include <string>

#include <parvane/call_session.h> // parvane::MediaBackend

namespace Parvane {

// Создаёт реальный webrtc-движок (audio-only). Ленивая инициализация общей
// фабрики/потоков/устройства при первом вызове. nullptr при фатальной ошибке
// инициализации webrtc (тогда вызывающий откатывается на заглушку).
[[nodiscard]] std::unique_ptr<parvane::MediaBackend> MakeWebrtcBackend();

// Устройства звонка из «Звук и камера» (ревью UI 7 ноя, п. 22): динамики, микрофон (→ PulseAudio) и камера.
// Звать на главном потоке перед звонком — значения берутся из Core::Settings.
void ApplyCallDeviceSettings();

} // namespace Parvane
