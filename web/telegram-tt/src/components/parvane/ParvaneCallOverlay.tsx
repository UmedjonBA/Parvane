import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';
import { callApi } from '../../api/gramjs';

import Button from '../ui/Button';

import styles from './ParvaneCallOverlay.module.scss';

type CallInfo = {
  state: string;
  peerName?: string;
  incoming?: { from: string; callId: string; media: string };
  remoteStream?: MediaStream;
};

function getWinCall(): CallInfo | undefined {
  return (window as unknown as { parvaneCall?: CallInfo }).parvaneCall;
}

function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const ParvaneCallOverlay = () => {
  const [call, setCall] = useState<CallInfo | undefined>();
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>();
  const activeSinceRef = useRef<number>();

  useEffect(() => {
    const onCall = () => setCall({ ...getWinCall() } as CallInfo);
    window.addEventListener('parvane-call', onCall);
    return () => window.removeEventListener('parvane-call', onCall);
  }, []);

  const state = call?.state;
  const isVisible = Boolean(state) && state !== 'ended';

  // Таймер длительности активного звонка
  useEffect(() => {
    if (state !== 'active') {
      activeSinceRef.current = undefined;
      setDuration(0);
      return undefined;
    }
    if (!activeSinceRef.current) activeSinceRef.current = Date.now();
    const timer = window.setInterval(() => {
      setDuration(Math.floor((Date.now() - activeSinceRef.current!) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  // Проигрываем удалённый аудиопоток
  useEffect(() => {
    if (call?.remoteStream && audioRef.current) {
      audioRef.current.srcObject = call.remoteStream;
      void audioRef.current.play().catch(() => undefined);
    }
  }, [call?.remoteStream]);

  if (!isVisible) return undefined;

  const isIncoming = state === 'incoming';
  const peerName = call?.peerName || call?.incoming?.from || 'Звонок';

  // parvane* — кастомные методы провайдера, вне типизированного Methods
  const anyCallApi = callApi as unknown as (name: string) => void;
  const handleAccept = () => anyCallApi('parvaneAcceptCall');
  const handleHangup = () => anyCallApi('parvaneHangUp');

  let statusText = '';
  if (state === 'requesting' || state === 'ringing') statusText = 'Вызов…';
  else if (state === 'incoming') statusText = 'Входящий звонок';
  else if (state === 'connecting') statusText = 'Соединение…';
  else if (state === 'active') statusText = formatDuration(duration);

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.avatar}>{peerName.charAt(0).toUpperCase()}</div>
        <div className={styles.name}>{peerName}</div>
        <div className={styles.status}>{statusText}</div>
        <div className={styles.actions}>
          {isIncoming && (
            <Button round color="translucent" className={styles.accept} onClick={handleAccept} ariaLabel="Accept">
              <i className={buildClassName(styles.icon, 'icon icon-phone')} />
            </Button>
          )}
          <Button round color="translucent" className={styles.hangup} onClick={handleHangup} ariaLabel="Hang up">
            <i className={buildClassName(styles.icon, 'icon icon-phone-discard')} />
          </Button>
        </div>
        <audio ref={audioRef} autoPlay />
      </div>
    </div>
  );
};

export default memo(ParvaneCallOverlay);
