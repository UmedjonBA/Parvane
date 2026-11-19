import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { ApiMusicTrackCard } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from '../../parvane/music/musicFormat';
import {
  callMusic, getMusicInfo, loadMusicInfo, playTracks,
} from '../../parvane/music/musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import Icon from '../../common/icons/Icon';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './MusicTrackCard.module.scss';

type OwnProps = {
  track: ApiMusicTrackCard;
};

// Parvane (TRACK-1): трек «Музыки» в чате — карточка с названием и исполнителем. Играет из библиотеки своего
// сервера: байтов трека в сообщении нет. Трек чужого сервера либо убранный из библиотеки только показывается
const MusicTrackCard = ({ track }: OwnProps) => {
  const lang = useLang();
  const { enabled } = useParvaneModules();
  const [problem, setProblem] = useState<'missing' | 'failed'>();
  const info = useDerivedState(getMusicInfo);
  const isMusicOn = enabled.includes('music');
  // Чей это трек, известно после сведений о «Музыке»: до них карточка только показывает
  const isOwnServer = info ? info.server === track.server : undefined;
  const canPlay = Boolean(isOwnServer && info?.isEnabled && isMusicOn);

  useEffect(() => {
    if (isMusicOn && !getMusicInfo()) void loadMusicInfo().catch(() => undefined);
  }, [isMusicOn]);

  const handlePlay = useLastCallback(async () => {
    try {
      const found = await callMusic('parvaneMusicTracks', { trackIds: [track.trackId] });
      if (!found.length) {
        setProblem('missing');
        return;
      }
      setProblem(undefined);
      playTracks(found, 0);
    } catch {
      setProblem('failed');
    }
  });

  return (
    <div className={styles.root} data-music-track-card={track.trackId}>
      <div className={styles.head}>
        {canPlay ? (
          <button type="button" className={styles.play} aria-label={lang('MusicTrackCardPlay')} onClick={handlePlay}>
            <Icon name="play" />
          </button>
        ) : (
          <span className={buildClassName(styles.play, styles.playOff)} aria-hidden>
            <Icon name="play" />
          </span>
        )}
        <div className={styles.titles}>
          <div className={styles.title}>{track.title}</div>
          {track.artist && <div className={styles.artist}>{track.artist}</div>}
        </div>
      </div>
      <div className={styles.source}>
        <Icon name="volume-1" className={styles.sourceIcon} />
        <span>
          {`${lang('MusicTrackCardLabel')} · `}
          <span className={kit.mono}>{formatTrackTime(track.durationSecs)}</span>
        </span>
      </div>
      {isOwnServer === false && (
        <p className={styles.note}>{lang('MusicTrackCardOtherServer', { server: track.server })}</p>
      )}
      {problem && (
        <p className={styles.note} role="status" data-track-problem={problem}>
          {lang(problem === 'missing' ? 'MusicTrackCardMissing' : 'MusicTrackCardFailed')}
        </p>
      )}
    </div>
  );
};

export default memo(MusicTrackCard);
