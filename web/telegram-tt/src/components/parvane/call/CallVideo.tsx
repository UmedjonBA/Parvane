import { memo, useEffect, useRef } from '../../../lib/teact/teact';

type OwnProps = {
  stream: MediaStream;
  className?: string;
  // Звук идёт отдельным элементом (личный звонок) либо это своя камера
  isSilent?: boolean;
};

// Поток звонка в `<video>`: привязка при появлении элемента и при смене потока. Элемент появляется позже
// потока (своя камера есть ещё на стадии вызова), поэтому привязка живёт в нём, а не в экране звонка
const CallVideo = ({ stream, className, isSilent }: OwnProps) => {
  const ref = useRef<HTMLVideoElement>();

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => undefined);
  }, [stream]);

  return <video ref={ref} className={className} autoPlay playsInline muted={isSilent} />;
};

export default memo(CallVideo);
