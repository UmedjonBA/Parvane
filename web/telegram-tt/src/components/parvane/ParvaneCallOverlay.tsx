import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';

import type { CallInfo } from './call/callTypes';

import { closeCallNotification, showCallNotification } from '../../util/pageNotify';
import { callApi } from '../../api/gramjs';
import { formatCallDuration, getWindowCall, hasVideoTrack } from './call/callTypes';

import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';

import CallActive from './call/CallActive';
import CallGroup from './call/CallGroup';
import CallIncoming from './call/CallIncoming';

import styles from './call/Call.module.scss';

const TICK_MS = 1000;

// parvane* — кастомные методы провайдера, вне типизированного Methods
const callParvane = callApi as unknown as (name: string) => void;

// Parvane: экраны звонка поверх приложения (доски `PhCalls`, `RpCalls`, `DkCalls`) — входящий, исходящий и
// идущий личный, групповой. Здесь состояние, таймер, звук и гудки; разметка — в `call/*`
const ParvaneCallOverlay = () => {
  const [call, setCall] = useState<CallInfo | undefined>();
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>();
  const lang = useOldLang();

  useEffect(() => {
    const updateCall = () => setCall({ ...getWindowCall() } as CallInfo);
    window.addEventListener('parvane-call', updateCall);
    return () => window.removeEventListener('parvane-call', updateCall);
  }, []);

  const state = call?.state;
  const group = call?.group;
  const isVisible = (Boolean(state) && state !== 'ended') || Boolean(group);
  // Личный звонок считает время с соединения, групповой — с входа в звонок
  const isTimed = state === 'active' || Boolean(group);

  useEffect(() => {
    setDuration(0);
    if (!isTimed) return undefined;
    const since = Date.now();
    const timer = window.setInterval(() => {
      setDuration(Math.floor((Date.now() - since) / TICK_MS));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [isTimed]);

  // Звук собеседника личного звонка — отдельным элементом: видео собеседника играет без звука
  const remoteStream = call?.remoteStream;
  useEffect(() => {
    if (!remoteStream || !audioRef.current) return;
    audioRef.current.srcObject = remoteStream;
    void audioRef.current.play().catch(() => undefined);
  }, [remoteStream]);

  // Гудки: входящий и исходящий — по кругу, «занято» — один раз
  useEffect(() => {
    let tone: HTMLAudioElement | undefined;
    if (state === 'incoming') tone = new Audio('call_incoming.mp3');
    else if (state === 'ringing') tone = new Audio('call_ringing.mp3');
    else if (state === 'busy') tone = new Audio('call_busy.mp3');
    if (!tone) return undefined;
    tone.loop = state !== 'busy';
    void tone.play().catch(() => undefined);
    return () => {
      tone.pause();
      tone.src = '';
    };
  }, [state]);

  // Входящий при скрытом окне — системное уведомление с «Ответить» и «Отклонить» (spec 041 F2, доска `ZpSystem`)
  const incomingCallId = state === 'incoming' ? call?.incoming?.callId : undefined;
  const incomingName = call?.pendingGroupTitle || call?.peerName || call?.incoming?.from;
  useEffect(() => {
    if (!incomingCallId) return undefined;
    showCallNotification(incomingCallId, incomingName || '');
    return closeCallNotification;
  }, [incomingCallId, incomingName]);

  const handleAccept = useLastCallback(() => callParvane('parvaneAcceptCall'));
  const handleHangup = useLastCallback(() => callParvane('parvaneHangUp'));
  const handleToggleMute = useLastCallback(() => callParvane('parvaneToggleMute'));
  const handleToggleCamera = useLastCallback(() => callParvane('parvaneToggleCamera'));

  if (!isVisible || !call) return undefined;

  const time = formatCallDuration(duration);

  if (group) {
    return (
      <div className={styles.overlay} data-call-screen="group">
        <CallGroup
          call={call}
          time={time}
          onToggleMute={handleToggleMute}
          onToggleCamera={handleToggleCamera}
          onHangup={handleHangup}
        />
      </div>
    );
  }

  const peerName = call.peerName || call.incoming?.from || lang('Call');

  if (state === 'incoming') {
    // Приглашение в групповой звонок ждёт согласия (микрофон ещё не открыт). Название группы есть, только
    // если приглашённый в ней состоит: в самом приглашении его нет
    const groupText = call.pendingGroupTitle
      ? lang('ParvaneGroupCallIncomingNamed', call.pendingGroupTitle)
      : lang('ParvaneGroupCallIncoming');
    return (
      <div className={styles.overlay} data-call-screen="incoming">
        <CallIncoming
          peerName={peerName}
          status={call.pendingGroup ? groupText : lang('CallStatusIncoming')}
          onAccept={handleAccept}
          onDecline={handleHangup}
        />
      </div>
    );
  }

  const hasRemoteVideo = hasVideoTrack(remoteStream) && !call.isRemoteCameraOff;

  return (
    <div className={styles.overlay} data-call-screen={hasRemoteVideo ? 'video' : 'voice'}>
      <CallActive
        call={call}
        peerName={peerName}
        time={time}
        hasRemoteVideo={hasRemoteVideo}
        onToggleMute={handleToggleMute}
        onToggleCamera={handleToggleCamera}
        onHangup={handleHangup}
      />
      <audio ref={audioRef} autoPlay />
    </div>
  );
};

export default memo(ParvaneCallOverlay);
