// Parvane fork: общие видео-треки текущего звонка. Мост между webrtc-бэкендом
// (кладёт сырые webrtc::VideoFrame) и нативным Calls::VideoBubble в экране звонка
// (рендерит трек). Никаких ARGB/QImage-конвертаций — трек сам всё делает, как в
// оригинальном клиенте. Треки создаются при открытии панели, сбрасываются при
// завершении звонка.
#pragma once

namespace webrtc {
class VideoFrame;
} // namespace webrtc

namespace Webrtc {
class VideoTrack;
} // namespace Webrtc

namespace Parvane {

// main-поток: создать/сбросить треки на границах звонка.
void CreateCallVideoTracks();
void ResetCallVideoTracks();

// main-поток: треки для Calls::VideoBubble (nullptr, если ещё не созданы).
[[nodiscard]] Webrtc::VideoTrack *CallRemoteVideoTrack();
[[nodiscard]] Webrtc::VideoTrack *CallLocalVideoTrack();

// webrtc-поток: положить кадр (удалённый / своя камера) в соответствующий трек.
void PushRemoteVideoFrame(const webrtc::VideoFrame &frame);
void PushLocalVideoFrame(const webrtc::VideoFrame &frame);

} // namespace Parvane
