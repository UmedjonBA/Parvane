import { memo } from '../../../lib/teact/teact';

import type { CallInfo } from './callTypes';

import { hasVideoTrack } from './callTypes';

import useOldLang from '../../../hooks/useOldLang';

import CallButton from './CallButton';
import CallPeerTile from './CallPeerTile';

import styles from './Call.module.scss';

type OwnProps = {
  call: CallInfo;
  time: string;
  onToggleMute: NoneToVoidFunction;
  onToggleCamera: NoneToVoidFunction;
  onHangup: NoneToVoidFunction;
};

const PEER_STATE_KEYS: Record<string, string> = {
  active: 'ParvaneCallConnected',
  connecting: 'ParvaneGroupPeerConnecting',
  busy: 'ParvaneGroupPeerBusy',
  declined: 'ParvaneGroupPeerDeclined',
};

// Групповой звонок (доски `PhCalls`, `DkCalls`): шапка с числом участников на связи, плитки, полоса кнопок
const CallGroup = ({
  call, time, onToggleMute, onToggleCamera, onHangup,
}: OwnProps) => {
  const lang = useOldLang();

  const group = call.group!;
  const peers = Object.keys(group.peerNames);
  const hasCamera = hasVideoTrack(call.localStream);
  const activeCount = peers.filter((peer) => group.peerStates[peer] === 'active').length + 1;

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <div className={styles.groupTitle}>{group.title}</div>
        <div className={styles.groupMeta}>
          <span>{lang('ParvaneGroupCall')}</span>
          {' · '}
          <span>{lang('ParvaneGroupCallCount', [activeCount, peers.length + 1])}</span>
          {' · '}
          <span>{time}</span>
        </div>
      </div>
      <div className={styles.tiles}>
        <CallPeerTile
          name={lang('ParvaneGroupCallYou')}
          status={lang('ParvaneCallConnected')}
          stream={hasCamera && !call.isCameraOff ? call.localStream : undefined}
          isOwn
          isMuted={call.isMuted}
        />
        {peers.map((peer, index) => {
          const peerState = group.peerStates[peer] || 'connecting';
          return (
            <CallPeerTile
              key={peer}
              peer={peer}
              peerState={peerState}
              name={group.peerNames[peer]}
              status={lang(PEER_STATE_KEYS[peerState] || PEER_STATE_KEYS.connecting)}
              stream={call.groupStreams?.[peer]}
              isCameraOff={call.groupCameraOff?.includes(peer)}
              tone={index + 1}
            />
          );
        })}
      </div>
      <div className={styles.groupBar}>
        <CallButton
          icon={call.isMuted ? 'icon-microphone-alt' : 'icon-microphone'}
          kind={call.isMuted ? 'on' : 'plain'}
          label={lang(call.isMuted ? 'ParvaneCallUnmute' : 'ParvaneCallMute')}
          onClick={onToggleMute}
        />
        {hasCamera && (
          <CallButton
            icon={call.isCameraOff ? 'icon-video-stop' : 'icon-video'}
            kind={call.isCameraOff ? 'plain' : 'on'}
            label={lang(call.isCameraOff ? 'ParvaneCallCameraOn' : 'ParvaneCallCameraOff')}
            onClick={onToggleCamera}
          />
        )}
        <CallButton icon="icon-phone-discard" kind="hangup" label={lang('CallEndCall')} onClick={onHangup} />
      </div>
    </div>
  );
};

export default memo(CallGroup);
