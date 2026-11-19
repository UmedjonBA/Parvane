import { memo, useEffect, useRef } from '../../../lib/teact/teact';

type OwnProps = {
  stream: MediaStream;
  sinkId: string;
};

const CallAudio = ({ stream, sinkId }: OwnProps) => {
  const ref = useRef<HTMLAudioElement>();

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.srcObject = stream;
    void audio.play().catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    const audio = ref.current;
    if (audio && audio.setSinkId && audio.sinkId !== sinkId) {
      void audio.setSinkId(sinkId).catch(() => undefined);
    }
  }, [sinkId]);

  return <audio ref={ref} autoPlay />;
};

export default memo(CallAudio);
