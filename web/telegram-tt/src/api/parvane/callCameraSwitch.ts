// Смена камеры в идущем звонке (доска `RpCalls`, кнопка «Сменить камеру»): новый трек уходит всем отправителям
// видео без ренеготиации и заменяет прежний в своём потоке — превью, новые участники mesh и возврат после показа
// экрана берут уже его

/** Следующая камера по кругу; `undefined` — переключать не на что. */
export function pickNextCamera(deviceIds: string[], currentId?: string) {
  const ids = deviceIds.filter(Boolean);
  if (ids.length < 2) return undefined;
  const index = currentId ? ids.indexOf(currentId) : -1;
  return ids[(index + 1) % ids.length];
}

/** Камер на устройстве больше одной — кнопку смены есть смысл показывать. */
export async function hasSeveralCameras() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  return devices.filter((device) => device.kind === 'videoinput').length > 1;
}

/** `isSharing` — идёт показ экрана: отправители заняты им, камера сменится в потоке и вернётся после показа. */
export async function switchCallCamera(stream: MediaStream, senders: RTCRtpSender[], isSharing: boolean) {
  const current = stream.getVideoTracks()[0];
  if (!current) return false;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const nextId = pickNextCamera(
    devices.filter((device) => device.kind === 'videoinput').map((device) => device.deviceId),
    current.getSettings().deviceId,
  );
  if (!nextId) return false;
  const fresh = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: nextId } } });
  const [track] = fresh.getVideoTracks();
  if (!track) return false;
  track.enabled = current.enabled;
  if (!isSharing) await Promise.all(senders.map((sender) => sender.replaceTrack(track)));
  stream.removeTrack(current);
  stream.addTrack(track);
  current.stop();
  return true;
}
