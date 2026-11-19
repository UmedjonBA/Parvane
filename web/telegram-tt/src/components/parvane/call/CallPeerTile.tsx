import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { getCallInitial, hasVideoTrack } from './callTypes';

import CallVideo from './CallVideo';

import styles from './Call.module.scss';

type OwnProps = {
  // Адрес участника; у своей плитки его нет
  peer?: string;
  peerState?: string;
  name: string;
  status: string;
  stream?: MediaStream;
  isOwn?: boolean;
  isMuted?: boolean;
  isCameraOff?: boolean;
  // Номер цвета кружка: участники различаются цветом, как в списке чатов
  tone?: number;
};

const TONE_CLASSES = [
  styles.toneBlue, styles.toneOrange, styles.tonePurple, styles.toneGreen, styles.toneRed, styles.toneAqua,
];

// Плитка участника группового звонка: кружок, имя и состояние; с камерой — её картинка. Видео участника
// несёт и его звук, поэтому элемент остаётся и при выключенной камере — тогда он скрыт
const CallPeerTile = ({
  peer, peerState, name, status, stream, isOwn, isMuted, isCameraOff, tone = 0,
}: OwnProps) => {
  const isPictureShown = hasVideoTrack(stream) && !isCameraOff;
  const isAway = peerState === 'busy' || peerState === 'declined';

  return (
    <div
      className={buildClassName(styles.tile, isPictureShown && styles.tileWithPicture, isAway && styles.tileAway)}
      data-peer={peer}
      data-peer-state={peerState}
      data-camera-off={isCameraOff ? '1' : undefined}
    >
      {stream && (
        <CallVideo
          stream={stream}
          className={buildClassName(styles.tileVideo, !isPictureShown && styles.tileVideoHidden)}
          isSilent={isOwn}
        />
      )}
      {!isPictureShown && (
        <span className={buildClassName(styles.tileAvatar, TONE_CLASSES[tone % TONE_CLASSES.length])} aria-hidden>
          {getCallInitial(name)}
        </span>
      )}
      <span className={styles.tileName}>{name}</span>
      <span className={styles.tileStatus}>{status}</span>
      {isMuted && <i className={buildClassName('icon icon-microphone-alt', styles.tileMuted)} aria-hidden />}
    </div>
  );
};

export default memo(CallPeerTile);
