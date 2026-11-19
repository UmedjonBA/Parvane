type ScreenShareOptions = {
  getSenders: () => RTCRtpSender[];
  getCamera: () => MediaStreamTrack | undefined;
  onChange: (stream?: MediaStream) => void;
  onError: () => void;
};

// В голосовом звонке видео согласовываем сразу, оставляя отправитель без дорожки
export function prepareCallVideo(pc: RTCPeerConnection, stream: MediaStream, isOffering: boolean) {
  if (stream.getVideoTracks().length) return;
  if (isOffering) {
    pc.addTransceiver?.('video', { direction: 'sendrecv', streams: [stream] });
    return;
  }
  const video = pc.getTransceivers?.().find((item) => item.receiver.track.kind === 'video');
  if (video?.sender.setStreams) {
    video.sender.setStreams(stream);
    video.direction = 'sendrecv';
  }
}

export function getCallVideoSender(pc?: RTCPeerConnection) {
  const video = pc?.getTransceivers?.().find((item) => item.receiver.track.kind === 'video');
  if (video?.currentDirection === 'sendrecv' || video?.currentDirection === 'sendonly') {
    return video.sender;
  }
  return undefined;
}

export function createCallScreenShare(options: ScreenShareOptions) {
  let stream: MediaStream | undefined;
  let generation = 0;
  let isChanging = false;

  async function restoreCamera(senders: RTCRtpSender[]) {
    const camera = options.getCamera();
    // В голосовом звонке достаточно остановить захват: отправитель остаётся без кадров
    if (!camera) return;
    await Promise.allSettled(senders.map((sender) => sender.replaceTrack(camera)));
  }

  async function stop() {
    const previous = stream;
    if (!previous) return;
    stream = undefined;
    const started = generation;
    isChanging = true;
    previous.getTracks().forEach((track) => track.stop());
    await restoreCamera(options.getSenders());
    if (started !== generation) return;
    isChanging = false;
    options.onChange();
  }

  async function toggle() {
    if (isChanging) return;
    if (stream) {
      await stop();
      return;
    }
    if (!options.getSenders().length || !navigator.mediaDevices?.getDisplayMedia) return;
    const started = generation;
    isChanging = true;
    let captured: MediaStream | undefined;
    try {
      captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const [track] = captured.getVideoTracks();
      if (started !== generation) {
        captured.getTracks().forEach((item) => item.stop());
        return;
      }
      const senders = options.getSenders();
      if (!track || !senders.length) {
        captured.getTracks().forEach((item) => item.stop());
        return;
      }
      stream = captured;
      const results = await Promise.allSettled(senders.map((sender) => sender.replaceTrack(track)));
      if (started !== generation) return;
      const currentSenders = options.getSenders();
      const hasFailed = results.some((result, index) => (
        result.status === 'rejected' && currentSenders.includes(senders[index])
      ));
      if (hasFailed || !currentSenders.length || track.readyState === 'ended') {
        await stop();
        if (started === generation) options.onError();
        return;
      }
      track.addEventListener('ended', () => {
        if (stream === captured) void stop();
      }, { once: true });
      options.onChange(stream);
    } catch (error) {
      if (started !== generation) return;
      if (!(error instanceof DOMException && error.name === 'NotAllowedError')) options.onError();
    } finally {
      if (started === generation) isChanging = false;
    }
  }

  async function attach(sender: RTCRtpSender) {
    const track = stream?.getVideoTracks()[0];
    if (track?.readyState !== 'live') return false;
    if (sender.track !== track) await sender.replaceTrack(track);
    return stream?.getVideoTracks()[0] === track;
  }

  function reset() {
    generation += 1;
    isChanging = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }

  return { attach, reset, toggle };
}
