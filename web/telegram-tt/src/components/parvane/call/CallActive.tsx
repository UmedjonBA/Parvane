import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import type { CallInfo } from './callTypes';

import buildClassName from '../../../util/buildClassName';
import { getCallSasWords } from './callSas';
import { getCallInitial, hasVideoTrack } from './callTypes';

import useLang from '../../../hooks/useLang';
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

const ROUTE_KEYS = {
  relay: 'ParvaneCallRelayed',
  direct: 'ParvaneCallDirect',
} as const;

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
  const langNew = useLang();

  const { state } = call;
  const isActive = state === 'active';
  const isConnected = isActive || state === 'connecting';
  const hasLocalVideo = hasVideoTrack(call.localStream);
  const preview = call.screenStream || (!call.isCameraOff && hasLocalVideo ? call.localStream : undefined);
  const isCameraShown = hasLocalVideo && !call.isCameraOff;
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
        {/* В голосовом звонке камеру можно включить: видео согласовано заранее */}
        {isConnected && (
          <CallButton
            icon={isCameraShown ? 'icon-video' : 'icon-video-stop'}
            kind={isCameraShown ? 'on' : 'plain'}
            label={lang(isCameraShown ? 'ParvaneCallCameraOff' : 'ParvaneCallCameraOn')}
            onClick={onToggleCamera}
          />
        )}
        {extraControls}
        <CallButton icon="icon-phone-discard" kind="hangup" label={langNew('ParvaneCallEnd')} onClick={onHangup} />
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
  function renderSas(className: string) {
    const words = getCallSasWords(call.sasFingerprints);
    if (!words) return undefined;
    return (
      <div className={className} title={lang('CallEmojiKeyTooltip', peerName)} data-call-sas>
        <div className={styles.sasHint}>{lang('ParvaneCallSasHint')}</div>
        <div className={styles.sasValue}>{words.join(' · ')}</div>
      </div>
    );
  }

  // Видеоэкран (доска `RpCalls`): время и слова сверки одной моноширинной строкой, без «на связи»
  function renderVideoStatus() {
    const words = getCallSasWords(call.sasFingerprints);
    if (!isActive) return renderStatus();
    return (
      <div className={styles.status} data-call-video-status>
        <span>{time}</span>
        {words && (
          <>
            {' · '}
            <span title={lang('CallEmojiKeyTooltip', peerName)} data-call-sas>{words.join(' · ')}</span>
          </>
        )}
      </div>
    );
  }

  if (hasRemoteVideo) {
    return (
      <div className={styles.video}>
        <CallVideo stream={call.remoteStream!} className={styles.videoRemote} isSilent />
        <div className={styles.videoHead}>
          <div className={styles.videoName}>{peerName}</div>
          {renderVideoStatus()}
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
      {isConnected && (
        <div className={buildClassName(styles.note, styles.routeNote)} data-call-route={call.route}>
          {call.route ? langNew(ROUTE_KEYS[call.route]) : lang('ParvaneCallEncrypted')}
        </div>
      )}
      {renderControls()}
      {/* Своя камера при выключенной у собеседника: превью в углу */}
      {preview && isConnected && (
        <CallVideo stream={preview} className={styles.voiceLocal} isSilent />
      )}
    </div>
  );
};

export default memo(CallActive);
