// Parvane fork: свой AudioDeviceModule для webrtc на PulseAudio. Нужен потому, что
// прибилженный libtg_owt собран БЕЗ линуксовых аудио-бэкендов (ALSA/Pulse) → его
// штатный ADM — dummy (тишина). Здесь настоящий захват/воспроизведение через
// libpulse-simple, отдаём кадры в webrtc AudioTransport. См. desktop/CALLS-parvane.md.
#pragma once

#include <api/scoped_refptr.h>

namespace webrtc {
class AudioDeviceModule;
} // namespace webrtc

namespace Parvane {

// Создать ADM на PulseAudio (48 кГц, моно, S16LE). Звать на worker-потоке webrtc.
[[nodiscard]] webrtc::scoped_refptr<webrtc::AudioDeviceModule>
CreatePulseAudioDeviceModule();

} // namespace Parvane
