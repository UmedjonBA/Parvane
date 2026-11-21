import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';

import type { CallInfo } from './callTypes';

import buildClassName from '../../../util/buildClassName';
import { GROUP_CALL_MAX_PARTICIPANTS } from '../../../api/parvane/groupcall';
import { hasVideoTrack } from './callTypes';

import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import CallButton from './CallButton';
import CallPeerTile from './CallPeerTile';

import styles from './Call.module.scss';

type OwnProps = {
  call: CallInfo;
  time: string;
  // Участники, которые сейчас говорят; `self` — своя плитка
  speakers: string[];
  onToggleMute: NoneToVoidFunction;
  onToggleCamera: NoneToVoidFunction;
  extraControls?: TeactNode;
  onMinimize: NoneToVoidFunction;
  onHangup: NoneToVoidFunction;
  // Позвать участника группы; группа неизвестна — кнопки и свободного места нет
  onInvite?: NoneToVoidFunction;
};

export const SELF_SPEAKER = 'self';

const PEER_STATE_KEYS: Record<string, string> = {
  active: 'ParvaneCallConnected',
  connecting: 'ParvaneGroupPeerConnecting',
  busy: 'ParvaneGroupPeerBusy',
  declined: 'ParvaneGroupPeerDeclined',
};

// Групповой звонок (доски `PhCalls`, `DkCalls`): шапка с числом участников на связи и «Позвать участника», плитки
// (говорящий — с рамкой, свободное место — зовёт участника), полоса кнопок
const CallGroup = ({
  call, time, speakers, onToggleMute, onToggleCamera, onHangup, extraControls, onMinimize, onInvite,
}: OwnProps) => {
  const lang = useOldLang();
  const langNew = useLang();

  const group = call.group!;
  const peers = Object.keys(group.peerNames);
  const hasCamera = hasVideoTrack(call.localStream);
  const isCameraShown = hasCamera && !call.isCameraOff;
  const activeCount = peers.filter((peer) => group.peerStates[peer] === 'active').length + 1;
  const hasFreePlace = Boolean(onInvite) && peers.length + 1 < GROUP_CALL_MAX_PARTICIPANTS;
  const inviteLabel = langNew('ParvaneCallInvite');

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <button
          type="button"
          className={styles.groupMinimize}
          aria-label={lang('ParvaneCallMinimize')}
          onClick={onMinimize}
        >
          <i className="icon icon-down" aria-hidden />
        </button>
        <div className={styles.groupHeading}>
          <div className={styles.groupTitle}>{group.title}</div>
          <div className={styles.groupMeta}>
            {/* Доски `PhCalls`, `DkCalls`: «название · 5 из 8 · 12:40»; «Групповой звонок» — для чтения с экрана */}
            <span className={styles.readerOnly}>{lang('ParvaneGroupCall')}</span>
            <span>{lang('ParvaneGroupCallCount', [activeCount, peers.length + 1])}</span>
            {' · '}
            <span>{time}</span>
          </div>
        </div>
        {onInvite && (
          <button
            type="button"
            className={styles.groupInvite}
            aria-label={inviteLabel}
            title={inviteLabel}
            onClick={onInvite}
          >
            <span className={styles.groupInvitePlus} aria-hidden>+</span>
            <span className={styles.groupInviteText}>{inviteLabel}</span>
          </button>
        )}
      </div>
      <div className={styles.tiles}>
        <CallPeerTile
          name={lang('ParvaneGroupCallYou')}
          status={lang('ParvaneCallConnected')}
          stream={call.screenStream || (hasCamera && !call.isCameraOff ? call.localStream : undefined)}
          isMuted={call.isMuted}
          isSpeaking={speakers.includes(SELF_SPEAKER)}
        />
        {peers.map((peer, index) => {
          const peerState = group.peerStates[peer] || 'connecting';
          const isSpeaking = peerState === 'active' && speakers.includes(peer);
          return (
            <CallPeerTile
              key={peer}
              peer={peer}
              peerState={peerState}
              name={group.peerNames[peer]}
              status={isSpeaking
                ? langNew('ParvaneCallSpeaking')
                : lang(PEER_STATE_KEYS[peerState] || PEER_STATE_KEYS.connecting)}
              stream={call.groupStreams?.[peer]}
              isCameraOff={call.groupVideoMuted?.[peer] ?? !hasCamera}
              isMuted={peerState === 'active' && call.groupAudioMuted?.[peer]}
              isSpeaking={isSpeaking}
              tone={index + 1}
            />
          );
        })}
        {hasFreePlace && (
          <button
            type="button"
            className={buildClassName(styles.tile, styles.tileAway, styles.tileFree)}
            data-call-free-place
            onClick={onInvite}
          >
            <span className={buildClassName(styles.tileAvatar, styles.tileFreeAvatar)} aria-hidden>+</span>
            <span className={styles.tileName}>{langNew('ParvaneCallFreePlace')}</span>
            <span className={styles.tileStatus}>{langNew('ParvaneCallFreePlaceHint')}</span>
          </button>
        )}
      </div>
      <div className={styles.groupBar}>
        <CallButton
          icon={call.isMuted ? 'icon-microphone-alt' : 'icon-microphone'}
          kind={call.isMuted ? 'on' : 'plain'}
          label={lang(call.isMuted ? 'ParvaneCallUnmute' : 'ParvaneCallMute')}
          onClick={onToggleMute}
        />
        {/* Камеру можно включить и в голосовом групповом звонке: видео согласовано с каждым участником */}
        <CallButton
          icon={isCameraShown ? 'icon-video' : 'icon-video-stop'}
          kind={isCameraShown ? 'on' : 'plain'}
          label={lang(isCameraShown ? 'ParvaneCallCameraOff' : 'ParvaneCallCameraOn')}
          onClick={onToggleCamera}
        />
        {extraControls}
        <CallButton icon="icon-phone-discard" kind="hangup" label={langNew('ParvaneCallLeave')} onClick={onHangup} />
      </div>
    </div>
  );
};

export default memo(CallGroup);
