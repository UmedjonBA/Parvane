// «Включить камеру» в голосовом звонке (доски `PhCalls`, `DkCalls`): видео согласовано заранее
// (`prepareCallVideo` оставляет отправитель без дорожки), поэтому камера встаёт в отправители `replaceTrack`
// без ренеготиации. Собеседник узнаёт о ней сигналом состояния медиа (конверт v2, `sendMediaState`)

type CameraDevices = Pick<MediaDevices, 'getUserMedia'>;

/** Камера добавлена в свой поток; `false` — камера уже есть, нет доступа или отправителей. */
export async function addCallCamera(
  stream: MediaStream,
  senders: RTCRtpSender[],
  isSharing: boolean,
  devices: CameraDevices | undefined = navigator.mediaDevices,
) {
  if (stream.getVideoTracks().length || !devices) return false;
  const captured = await devices.getUserMedia({ video: true });
  const [track] = captured.getVideoTracks();
  if (!track) return false;
  // Пока идёт показ экрана, отправители заняты им: камера уйдёт им после остановки показа
  if (!isSharing) {
    const results = await Promise.allSettled(senders.map((sender) => sender.replaceTrack(track)));
    if (senders.length && results.every((result) => result.status === 'rejected')) {
      track.stop();
      return false;
    }
  }
  stream.addTrack(track);
  return true;
}
