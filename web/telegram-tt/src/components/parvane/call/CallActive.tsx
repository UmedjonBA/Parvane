import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import type { CallInfo } from './callTypes';

import buildClassName from '../../../util/buildClassName';
import { getCallSasWords } from './callSas';
import { getCallInitial, hasVideoTrack } from './callTypes';

import useOldLang from '../../../hooks/useOldLang';

import CallButton from './CallButton';
import CallVideo from './CallVideo';

import styles from './Call.module.scss';

type OwnProps = {
  call: CallInfo;
  peerName: string;
  time: string;
  hasRemoteVideo: boolean;
  onToggleMute: NoneToVoidFunction;
  onToggleCamera: NoneToVoidFunction;
  extraControls?: TeactNode;
  onMinimize?: NoneToVoidFunction;
  onHangup: NoneToVoidFunction;
};

const STATUS_KEYS: Record<string, string> = {
  requesting: 'CallStatusRequesting',
  ringing: 'CallStatusRinging',
  connecting: 'CallStatusExchanging',
  busy: 'ParvaneCallBusy',
  security_failed: 'ParvaneCallSecurityError',
};

// Исходящий и идущий личный звонок (доски `PhCalls`, `DkCalls`); с видео собеседника — тёмный экран `RpCalls`
const CallActive = ({
  call, peerName, time, hasRemoteVideo, onToggleMute, onToggleCamera, onHangup, extraControls, onMinimize,
}: OwnProps) => {
  const lang = useOldLang();

  const { state } = call;
  const isActive = state === 'active';
  const isConnected = isActive || state === 'connecting';
  const hasLocalVideo = hasVideoTrack(call.localStream);
  const preview = call.screenStream || (!call.isCameraOff && hasLocalVideo ? call.localStream : undefined);
  const showRemoteCameraOff = hasLocalVideo && call.isRemoteCameraOff;
  const statusKey = STATUS_KEYS[state];

  function renderStatus() {
    return (
      <div className={buildClassName(styles.status, call.hasSecurityError && styles.statusError)}>
        {isActive ? (
          <>
            <span>{lang('ParvaneCallConnected')}</span>
            {' · '}
            <span>{time}</span>
          </>
        ) : (statusKey && lang(statusKey))}
      </div>
    );
  }

  function renderRemoteState() {
    if (!isConnected || !(showRemoteCameraOff || call.isRemoteMuted)) return undefined;
    return (
      <div className={styles.remoteState}>
        {showRemoteCameraOff && (
          <span className={styles.remoteItem} data-remote-camera-off>
            <i className="icon icon-video-stop" aria-hidden />
            {lang('ParvaneCallPeerCameraOff')}
          </span>
        )}
        {call.isRemoteMuted && (
          <span className={styles.remoteItem} data-remote-muted>
            <i className="icon icon-microphone-alt" aria-hidden />
            {lang('ParvaneCallPeerMuted')}
          </span>
        )}
      </div>
    );
  }

  function renderControls() {
    return (
      <div className={styles.controls}>
        {isConnected && (
          <CallButton
            icon={call.isMuted ? 'icon-microphone-alt' : 'icon-microphone'}
            kind={call.isMuted ? 'on' : 'plain'}
            label={lang(call.isMuted ? 'ParvaneCallUnmute' : 'ParvaneCallMute')}
            onClick={onToggleMute}
          />
        )}
        {isConnected && hasLocalVideo && (
          <CallButton
            icon={call.isCameraOff ? 'icon-video-stop' : 'icon-video'}
            kind={call.isCameraOff ? 'plain' : 'on'}
            label={lang(call.isCameraOff ? 'ParvaneCallCameraOn' : 'ParvaneCallCameraOff')}
            onClick={onToggleCamera}
          />
        )}
        {extraControls}
        <CallButton icon="icon-phone-discard" kind="hangup" label={lang('CallEndCall')} onClick={onHangup} />
      </div>
    );
  }

  function renderMinimize() {
    if (!onMinimize) return undefined;
    return (
      <button
        type="button"
        className={styles.minimize}
        aria-label={lang('ParvaneCallMinimize')}
        onClick={onMinimize}
      >
        <i className="icon icon-down" aria-hidden />
      </button>
    );
  }

  // Сверка ключей словами (CALL-3): четыре слова одинаковы у обоих собеседников
  function renderSas(className: string, noHint?: boolean) {
    const words = getCallSasWords(call.sasFingerprints);
    if (!words) return undefined;
    return (
      <div className={className} title={lang('CallEmojiKeyTooltip', peerName)} data-call-sas>
        {!noHint && <div className={styles.sasHint}>{lang('ParvaneCallSasHint')}</div>}
        <div className={styles.sasValue}>{words.join(' · ')}</div>
      </div>
    );
  }

  if (hasRemoteVideo) {
    return (
      <div className={styles.video}>
        <CallVideo stream={call.remoteStream!} className={styles.videoRemote} isSilent />
        <div className={styles.videoHead}>
          <div className={styles.videoName}>{peerName}</div>
          {renderStatus()}
          {renderSas(styles.videoSas, true)}
          {renderRemoteState()}
        </div>
        {renderMinimize()}
        {preview && <CallVideo stream={preview} className={styles.videoLocal} isSilent />}
        {renderControls()}
      </div>
    );
  }

  return (
    <div className={styles.voice}>
      {renderMinimize()}
      <div className={styles.avatar} aria-hidden>{getCallInitial(peerName)}</div>
      <div className={styles.name}>{peerName}</div>
      {renderStatus()}
      {renderRemoteState()}
      {renderSas(styles.sas)}
      <div className={styles.spacer} />
      {isConnected && <div className={styles.note}>{lang('ParvaneCallEncrypted')}</div>}
      {renderControls()}
      {/* Своя камера при выключенной у собеседника: превью в углу */}
      {preview && isConnected && (
        <CallVideo stream={preview} className={styles.voiceLocal} isSilent />
      )}
    </div>
  );
};

export default memo(CallActive);
