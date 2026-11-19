import { memo, useEffect, useLayoutEffect, useState } from '../../lib/teact/teact';

import type { CallInfo } from './call/callTypes';

import { closeCallNotification, showCallNotification } from '../../util/pageNotify';
import { callApi } from '../../api/gramjs';
import { formatCallDuration, getWindowCall, hasVideoTrack } from './call/callTypes';
import useCallAudioOutput from './call/useCallAudioOutput';
import { getMusicPlayer, togglePlay } from './music/musicPlayer';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';

import CallActive from './call/CallActive';
import CallAudio from './call/CallAudio';
import CallButton from './call/CallButton';
import CallGroup from './call/CallGroup';
import CallIncoming from './call/CallIncoming';
import CallMinimized from './call/CallMinimized';
import CallOutputList from './call/CallOutputList';

import styles from './call/Call.module.scss';

const TICK_MS = 1000;

// parvane* — кастомные методы провайдера, вне типизированного Methods
const callParvane = callApi as unknown as (name: string) => void;

// Parvane: экраны звонка поверх приложения (доски `PhCalls`, `RpCalls`, `DkCalls`) — входящий, исходящий и
// идущий личный, групповой. Здесь состояние, таймер, звук и гудки; разметка — в `call/*`
const ParvaneCallOverlay = () => {
  const [call, setCall] = useState<CallInfo | undefined>();
  const [duration, setDuration] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);
  const langNew = useLang();
  const lang = useOldLang();

  useEffect(() => {
    const updateCall = () => {
      const current = getWindowCall();
      setCall(current && { ...current });
    };
    updateCall();
    window.addEventListener('parvane-call', updateCall);
    return () => window.removeEventListener('parvane-call', updateCall);
  }, []);

  const state = call?.state;
  const group = call?.group;
  const isVisible = (Boolean(state) && state !== 'ended') || Boolean(group);
  // Личный звонок считает время с соединения, групповой — с входа в звонок
  const isTimed = state === 'active' || Boolean(group);
  const output = useCallAudioOutput(isTimed, call?.localStream);
  const { resetOutput, isOutputOpen } = output;
  const groupId = group?.groupCallId;

  useLayoutEffect(() => {
    if (isTimed) return;
    setIsMinimized(false);
    resetOutput();
  }, [isTimed, resetOutput]);

  // Доска `RpCalls`: на время звонка мини-плеер ставится на паузу; после звонка музыка сама не возобновляется
  useEffect(() => {
    if (isTimed && getMusicPlayer().isPlaying) togglePlay();
  }, [isTimed]);

  useEffect(() => {
    setDuration(0);
    if (!isTimed) return undefined;
    const since = Date.now();
    const timer = window.setInterval(() => {
      setDuration(Math.floor((Date.now() - since) / TICK_MS));
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [isTimed, groupId]);

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

  const handleToggleScreen = useLastCallback(() => callParvane('parvaneToggleScreenShare'));
  const handleExpand = useLastCallback(() => setIsMinimized(false));
  const handleMinimize = useLastCallback(() => {
    output.closeOutput();
    setIsMinimized(true);
  });

  useLayoutEffect(() => {
    if (!isTimed || isMinimized || isOutputOpen) return undefined;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handleMinimize();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [isTimed, isMinimized, isOutputOpen, handleMinimize]);

  if (!isVisible || !call) return undefined;

  const time = formatCallDuration(duration);

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

  const remoteStream = call.remoteStream;
  const hasRemoteVideo = hasVideoTrack(remoteStream)
    && !(call.isRemoteCameraOff ?? !hasVideoTrack(call.localStream));
  const streams = group ? Object.values(call.groupStreams || {}) : (remoteStream ? [remoteStream] : []);
  const isSharing = Boolean(call.screenStream);
  const extraControls = (
    <>
      {output.canChooseOutput && (
        <CallButton
          icon="icon-speaker"
          kind={output.sinkId ? 'on' : 'plain'}
          label={langNew('ParvaneCallAudioOutput')}
          onClick={output.toggleOutput}
        />
      )}
      {isTimed && (isSharing || (call.canShareScreen && Boolean(navigator.mediaDevices?.getDisplayMedia))) && (
        <CallButton
          icon={isSharing ? 'icon-share-screen-stop' : 'icon-share-screen'}
          kind={isSharing ? 'on' : 'plain'}
          label={langNew(isSharing ? 'ParvaneCallStopSharing' : 'ParvaneCallShareScreen')}
          onClick={handleToggleScreen}
        />
      )}
    </>
  );

  return (
    <>
      {/* Звук живёт вне экранов звонка и продолжает играть при сворачивании и смене модуля */}
      <div ref={output.audioHostRef} data-call-audio hidden>
        {streams.map((stream) => <CallAudio key={stream.id} stream={stream} sinkId={output.sinkId} />)}
      </div>
      {isTimed && isMinimized ? (
        <CallMinimized name={group?.title || peerName} time={time} onExpand={handleExpand} />
      ) : (
        <div className={styles.overlay} data-call-screen={group ? 'group' : (hasRemoteVideo ? 'video' : 'voice')}>
          {group ? (
            <CallGroup
              call={call}
              time={time}
              onToggleMute={handleToggleMute}
              onToggleCamera={handleToggleCamera}
              onHangup={handleHangup}
              onMinimize={handleMinimize}
              extraControls={extraControls}
            />
          ) : (
            <CallActive
              call={call}
              peerName={peerName}
              time={time}
              hasRemoteVideo={hasRemoteVideo}
              onToggleMute={handleToggleMute}
              onToggleCamera={handleToggleCamera}
              onHangup={handleHangup}
              onMinimize={isTimed ? handleMinimize : undefined}
              extraControls={extraControls}
            />
          )}
          {isOutputOpen && (
            <CallOutputList
              outputs={output.outputs}
              sinkId={output.sinkId}
              onChoose={output.chooseOutput}
              onClose={output.closeOutput}
            />
          )}
          {(call.hasScreenShareError || output.hasOutputError) && (
            <div className={styles.mediaError} role="status">
              {langNew(call.hasScreenShareError ? 'ParvaneCallScreenError' : 'ParvaneCallAudioError')}
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default memo(ParvaneCallOverlay);
