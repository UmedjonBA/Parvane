import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';
import { callApi } from '../../api/gramjs';

import useOldLang from '../../hooks/useOldLang';

import Button from '../ui/Button';

import styles from './ParvaneCallOverlay.module.scss';

type CallInfo = {
  state: string;
  peerName?: string;
  incoming?: { from: string; callId: string; media: string };
  remoteStream?: MediaStream;
  localStream?: MediaStream;
  sas?: string;
  hasSecurityError?: boolean;
  isMuted?: boolean;
  isCameraOff?: boolean;
  group?: {
    groupCallId: string;
    title: string;
    peerStates: Record<string, string>;
    peerNames: Record<string, string>;
  };
  groupStreams?: Record<string, MediaStream>;
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
  const remoteVideoRef = useRef<HTMLVideoElement>();
  const localVideoRef = useRef<HTMLVideoElement>();
  const activeSinceRef = useRef<number>();
  const lang = useOldLang();

  useEffect(() => {
    const onCall = () => setCall({ ...getWinCall() } as CallInfo);
    window.addEventListener('parvane-call', onCall);
    return () => window.removeEventListener('parvane-call', onCall);
  }, []);

  const state = call?.state;
  const group = call?.group;
  const isVisible = (Boolean(state) && state !== 'ended') || Boolean(group);

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

  const hasRemoteVideo = Boolean(call?.remoteStream?.getVideoTracks().length);
  const hasLocalVideo = Boolean(call?.localStream?.getVideoTracks().length);

  // Проигрываем удалённый поток: аудио всегда, видео — при наличии трека
  useEffect(() => {
    if (call?.remoteStream && audioRef.current) {
      audioRef.current.srcObject = call.remoteStream;
      void audioRef.current.play().catch(() => undefined);
    }
    if (call?.remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = call.remoteStream;
      void remoteVideoRef.current.play().catch(() => undefined);
    }
  }, [call?.remoteStream, hasRemoteVideo]);

  // Локальное превью камеры. ВАЖНО: у звонящего localStream появляется ещё на
  // стадии 'ringing' (до монтирования <video> превью), а к 'active' ССЫЛКА на
  // поток та же — эффект с deps только по потоку не перезапускался, и srcObject
  // не привязывался к уже смонтированному элементу (чёрное превью у инициатора).
  // Поэтому пере-привязываем и при смене стадии/режима (state/group), когда
  // элемент появляется в разметке.
  useEffect(() => {
    if (call?.localStream && localVideoRef.current) {
      if (localVideoRef.current.srcObject !== call.localStream) {
        localVideoRef.current.srcObject = call.localStream;
      }
      void localVideoRef.current.play().catch(() => undefined);
    }
  }, [call?.localStream, hasLocalVideo, state, group]);

  // Рингтоны: входящий и исходящий гудок — loop, «занято» — однократно
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

  // Групповой звонок: видео-тайл на каждого участника (video проигрывает и
  // звук). DOM управляется вручную — количество участников динамическое
  const groupTilesRef = useRef<HTMLDivElement>();
  const groupStreams = call?.groupStreams;
  const groupPeerNames = group?.peerNames;
  useEffect(() => {
    const container = groupTilesRef.current;
    if (!container) return;
    const streams = Object.entries(groupStreams || {});
    const existing = new Map(
      Array.from(container.querySelectorAll<HTMLElement>('[data-peer]')).map((el) => [el.dataset.peer!, el]),
    );
    streams.forEach(([peer, stream]) => {
      let tile = existing.get(peer);
      if (!tile) {
        tile = document.createElement('div');
        tile.dataset.peer = peer;
        tile.className = styles.groupTile;
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.className = styles.groupTileVideo;
        tile.appendChild(video);
        const label = document.createElement('span');
        label.className = styles.groupTileName;
        tile.appendChild(label);
        container.appendChild(tile);
      }
      const video = tile.querySelector('video')!;
      if (video.srcObject !== stream) {
        video.srcObject = stream;
        void video.play().catch(() => undefined);
      }
      tile.querySelector('span')!.textContent = groupPeerNames?.[peer] || peer;
      existing.delete(peer);
    });
    existing.forEach((el) => el.remove());
  }, [groupStreams, groupPeerNames]);

  const hasGroupVideo = Boolean(call?.localStream?.getVideoTracks().length);

  if (!isVisible) return undefined;

  const isIncoming = state === 'incoming';
  const peerName = call?.peerName || call?.incoming?.from || lang('Call');

  // parvane* — кастомные методы провайдера, вне типизированного Methods
  const anyCallApi = callApi as unknown as (name: string) => void;
  const handleAccept = () => anyCallApi('parvaneAcceptCall');
  const handleHangup = () => anyCallApi('parvaneHangUp');
  const handleToggleMute = () => anyCallApi('parvaneToggleMute');
  const handleToggleCamera = () => anyCallApi('parvaneToggleCamera');
  const isActive = state === 'active' || state === 'connecting';
  const muteIcon = call?.isMuted ? 'icon-microphone-alt' : 'icon-microphone';
  const cameraIcon = call?.isCameraOff ? 'icon-video-stop' : 'icon-video';

  let statusText = '';
  if (state === 'requesting') statusText = lang('CallStatusRequesting');
  else if (state === 'ringing') statusText = lang('CallStatusRinging');
  else if (state === 'incoming') statusText = lang('CallStatusIncoming');
  else if (state === 'connecting') statusText = lang('CallStatusExchanging');
  else if (state === 'active') statusText = formatDuration(duration);
  else if (state === 'busy') statusText = lang('ParvaneCallBusy');
  else if (state === 'security_failed') statusText = lang('ParvaneCallSecurityError');

  if (group) {
    return (
      <div className={styles.overlay}>
        <div className={buildClassName(styles.card, hasGroupVideo && styles.videoCard)}>
          <div className={styles.name}>{group.title}</div>
          <div className={styles.status}>{lang('ParvaneGroupCall')}</div>
          {/* Видео-тайлы удалённых участников (video проигрывает и звук) */}
          <div ref={groupTilesRef} className={styles.groupGrid} />
          {hasGroupVideo && !call?.isCameraOff && (
            <video ref={localVideoRef} className={styles.groupSelf} autoPlay playsInline muted />
          )}
          <div className={styles.groupPeers}>
            {Object.entries(group.peerNames).map(([peer, name]) => {
              const peerState = group.peerStates[peer] || 'connecting';
              return (
                <div key={peer} className={styles.groupPeer} data-peer-state={peerState}>
                  <span
                    className={buildClassName(
                      styles.peerDot,
                      peerState === 'active' && styles.peerDotActive,
                    )}
                  />
                  {name}
                </div>
              );
            })}
          </div>
          <div className={styles.actions}>
            <Button
              round
              color="translucent"
              className={buildClassName(styles.control, call?.isMuted && styles.controlOff)}
              onClick={handleToggleMute}
              ariaLabel={lang(call?.isMuted ? 'ParvaneCallUnmute' : 'ParvaneCallMute')}
            >
              <i className={buildClassName(styles.icon, 'icon', muteIcon)} />
            </Button>
            {hasGroupVideo && (
              <Button
                round
                color="translucent"
                className={buildClassName(styles.control, call?.isCameraOff && styles.controlOff)}
                onClick={handleToggleCamera}
                ariaLabel={lang(call?.isCameraOff ? 'ParvaneCallCameraOn' : 'ParvaneCallCameraOff')}
              >
                <i className={buildClassName(styles.icon, 'icon', cameraIcon)} />
              </Button>
            )}
            <Button
              round
              color="translucent"
              className={styles.hangup}
              onClick={handleHangup}
              ariaLabel={lang('CallEndCall')}
            >
              <i className={buildClassName(styles.icon, 'icon icon-phone-discard')} />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay}>
      <div className={buildClassName(styles.card, hasRemoteVideo && styles.videoCard)}>
        {hasRemoteVideo && (
          <div className={styles.videoArea}>
            {/* Звук идёт через отдельный audio-элемент — иначе дублируется */}
            <video ref={remoteVideoRef} className={styles.remoteVideo} autoPlay playsInline muted />
            {hasLocalVideo && !call?.isCameraOff && (
              <video ref={localVideoRef} className={styles.localPreview} autoPlay playsInline muted />
            )}
          </div>
        )}
        {!hasRemoteVideo && <div className={styles.avatar}>{peerName.charAt(0).toUpperCase()}</div>}
        <div className={styles.name}>{peerName}</div>
        <div className={buildClassName(styles.status, call?.hasSecurityError && styles.securityError)}>
          {statusText}
        </div>
        {call?.sas && (
          <div className={styles.sas} title={lang('CallEmojiKeyTooltip', peerName)}>
            {call.sas}
          </div>
        )}
        <div className={styles.actions}>
          {isIncoming && (
            <Button
              round
              color="translucent"
              className={styles.accept}
              onClick={handleAccept}
              ariaLabel={lang('CallAccept')}
            >
              <i className={buildClassName(styles.icon, 'icon icon-phone')} />
            </Button>
          )}
          {isActive && (
            <Button
              round
              color="translucent"
              className={buildClassName(styles.control, call?.isMuted && styles.controlOff)}
              onClick={handleToggleMute}
              ariaLabel={lang(call?.isMuted ? 'ParvaneCallUnmute' : 'ParvaneCallMute')}
            >
              <i className={buildClassName(styles.icon, 'icon', muteIcon)} />
            </Button>
          )}
          {isActive && hasLocalVideo && (
            <Button
              round
              color="translucent"
              className={buildClassName(styles.control, call?.isCameraOff && styles.controlOff)}
              onClick={handleToggleCamera}
              ariaLabel={lang(call?.isCameraOff ? 'ParvaneCallCameraOn' : 'ParvaneCallCameraOff')}
            >
              <i className={buildClassName(styles.icon, 'icon', cameraIcon)} />
            </Button>
          )}
          <Button
            round
            color="translucent"
            className={styles.hangup}
            onClick={handleHangup}
            ariaLabel={lang('CallEndCall')}
          >
            <i className={buildClassName(styles.icon, 'icon icon-phone-discard')} />
          </Button>
        </div>
        <audio ref={audioRef} autoPlay />
      </div>
    </div>
  );
};

export default memo(ParvaneCallOverlay);
