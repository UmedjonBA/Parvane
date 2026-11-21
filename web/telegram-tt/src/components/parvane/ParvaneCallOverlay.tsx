import { memo, useEffect, useLayoutEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { CallAction } from '../../api/parvane/calls';
import type { CallCandidate } from './call/CallInvitePicker';
import type { CallInfo } from './call/callTypes';

import { closeCallNotification, showCallNotification } from '../../util/pageNotify';
import { callApi } from '../../api/gramjs';
import { hasSeveralCameras } from '../../api/parvane/callCameraSwitch';
import { formatCallDuration, getWindowCall, hasVideoTrack } from './call/callTypes';
import useCallAudioOutput from './call/useCallAudioOutput';
import useCallSpeakers from './call/useCallSpeakers';
import { getMusicPlayer, togglePlay } from './music/musicPlayer';

import useAppLayout from '../../hooks/useAppLayout';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';

import CallActive from './call/CallActive';
import CallAudio from './call/CallAudio';
import CallButton from './call/CallButton';
import CallGroup, { SELF_SPEAKER } from './call/CallGroup';
import CallIncoming from './call/CallIncoming';
import CallInvitePicker from './call/CallInvitePicker';
import CallMinimized from './call/CallMinimized';
import CallOutputList from './call/CallOutputList';
import CallWaitingInvite from './call/CallWaitingInvite';

import styles from './call/Call.module.scss';

const TICK_MS = 1000;

// parvane* — кастомные методы провайдера, вне типизированного Methods
const callParvane = callApi as unknown as (name: string, args?: unknown) => Promise<unknown> | undefined;

function runCallAction(action: CallAction, address?: string) {
  return callParvane('parvaneCallAction', { action, address });
}

// Parvane: экраны звонка поверх приложения (доски `PhCalls`, `RpCalls`, `DkCalls`) — входящий, исходящий и
// идущий личный, групповой. Здесь состояние, таймер, звук и гудки; разметка — в `call/*`
const ParvaneCallOverlay = () => {
  const { openChat } = getActions();
  const [call, setCall] = useState<CallInfo | undefined>();
  const [duration, setDuration] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  // «Позвать участника»: выбор открыт; `candidates` — `undefined`, пока список грузится
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [candidates, setCandidates] = useState<CallCandidate[] | undefined>();
  const langNew = useLang();
  const lang = useOldLang();
  const { isMobile } = useAppLayout();

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
    setIsInviteOpen(false);
    resetOutput();
  }, [isTimed, resetOutput]);

  // «Сменить камеру» (доска `RpCalls`) — только если камер больше одной
  const hasLocalVideo = hasVideoTrack(call?.localStream);
  useEffect(() => {
    setCanSwitchCamera(false);
    if (!isTimed || !hasLocalVideo) return undefined;
    let isActual = true;
    void hasSeveralCameras().then((hasSeveral) => {
      if (isActual) setCanSwitchCamera(hasSeveral);
    });
    return () => {
      isActual = false;
    };
  }, [isTimed, hasLocalVideo]);

  // Кто говорит: свой микрофон и звук каждого участника группового звонка
  const speakers = useCallSpeakers(group ? {
    ...call?.groupStreams,
    [SELF_SPEAKER]: call?.isMuted ? undefined : call?.localStream,
  } : {});

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
    setIsInviteOpen(false);
    setIsMinimized(true);
  });
  const handleSwitchCamera = useLastCallback(() => runCallAction('switchCamera'));
  const handleAcceptWaiting = useLastCallback(() => runCallAction('acceptWaiting'));
  const handleDeclineWaiting = useLastCallback(() => runCallAction('declineWaiting'));

  // «Ответить сообщением» (доска `RpCalls`): вызов отклоняется, открывается чат со звонящим
  const handleReplyWithMessage = useLastCallback(() => {
    const chatId = call?.peerChatId;
    handleHangup();
    if (chatId) openChat({ id: chatId });
  });

  // «Открыть чат» (доска `DkCalls`): звонок сворачивается в плашку, открывается чат собеседника либо группы
  const handleOpenChat = useLastCallback(() => {
    const chatId = call?.peerChatId;
    if (!chatId) return;
    handleMinimize();
    openChat({ id: chatId });
  });

  const handleOpenInvite = useLastCallback(() => {
    output.closeOutput();
    setCandidates(undefined);
    setIsInviteOpen(true);
    void runCallAction('candidates')?.then((list) => setCandidates(list as CallCandidate[]));
  });
  const handleCloseInvite = useLastCallback(() => setIsInviteOpen(false));
  const handleInvite = useLastCallback((address: string) => {
    setIsInviteOpen(false);
    void runCallAction('invite', address);
  });

  useLayoutEffect(() => {
    if (!isTimed || isMinimized || isOutputOpen || isInviteOpen) return undefined;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handleMinimize();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [isTimed, isMinimized, isOutputOpen, isInviteOpen, handleMinimize]);

  const waiting = call?.waitingInvite;
  const waitingCard = waiting && (
    <CallWaitingInvite
      fromName={waiting.fromName}
      title={waiting.title}
      onAccept={handleAcceptWaiting}
      onDecline={handleDeclineWaiting}
    />
  );

  if (!isVisible || !call) return waitingCard;

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
          isStatusHidden={!call.pendingGroup}
          handle={call.peerHandle}
          isContact={call.isPeerContact}
          onAccept={handleAccept}
          onDecline={handleHangup}
          onReplyWithMessage={call.peerChatId ? handleReplyWithMessage : undefined}
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
      {canSwitchCamera && (
        <CallButton icon="icon-flip" label={langNew('ParvaneCallSwitchCamera')} onClick={handleSwitchCamera} />
      )}
      {/* На телефоне — «Громкая связь» всегда (доски `PhCalls`, `RpCalls`); выбрать вывод можно, только если браузер
        даёт `setSinkId` и выходов несколько, иначе кнопка недоступна с объяснением */}
      {(output.canChooseOutput || isMobile) && (
        <CallButton
          icon="icon-speaker"
          kind={output.sinkId ? 'on' : 'plain'}
          label={langNew(isMobile ? 'ParvaneCallSpeaker' : 'ParvaneCallAudioOutput')}
          isDisabled={!output.canChooseOutput}
          hint={output.canChooseOutput ? undefined : langNew('ParvaneCallSpeakerUnavailable')}
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
      {isTimed && call.peerChatId && (
        <CallButton icon="icon-message" label={langNew('ParvaneCallOpenChat')} onClick={handleOpenChat} />
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
              speakers={speakers}
              onInvite={group.address ? handleOpenInvite : undefined}
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
          {isInviteOpen && (
            <CallInvitePicker candidates={candidates} onChoose={handleInvite} onClose={handleCloseInvite} />
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
      {waitingCard}
    </>
  );
};

export default memo(ParvaneCallOverlay);
