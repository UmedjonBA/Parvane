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

// Устройства звонка из «Звук и камера» (ревью UI 7 ноя, п. 22): id из настроек tdesktop (OpenAL — описание
// устройства); при открытии потока сопоставляются с устройствами PulseAudio, не нашлось — устройство по умолчанию.
// Звать на главном потоке перед звонком.
void SetCallAudioDevices(const std::string &playbackId, const std::string &captureId);

} // namespace Parvane
