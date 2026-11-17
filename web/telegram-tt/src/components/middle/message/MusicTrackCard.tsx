import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { ApiMusicTrackCard } from '../../../api/types';

import { formatTrackTime } from '../../parvane/music/musicFormat';
import {
  callMusic, getMusicInfo, loadMusicInfo, playTracks,
} from '../../parvane/music/musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';

import styles from './ArticleCard.module.scss';

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
        <span className={styles.badge}>
          <Icon name="play" />
        </span>
        <div className={styles.titles}>
          <span className={styles.label}>
            {[track.artist || lang('MusicTrackCardLabel'), formatTrackTime(track.durationSecs)].join(' · ')}
          </span>
          <span className={styles.title}>{track.title}</span>
        </div>
      </div>
      {isOwnServer === false && (
        <p className={styles.preview}>{lang('MusicTrackCardOtherServer', { server: track.server })}</p>
      )}
      {problem && (
        <p className={styles.preview} role="status" data-track-problem={problem}>
          {lang(problem === 'missing' ? 'MusicTrackCardMissing' : 'MusicTrackCardFailed')}
        </p>
      )}
      {canPlay && (
        <div className={styles.actions}>
          <Button size="tiny" noForcedUpperCase onClick={handlePlay}>{lang('MusicTrackCardPlay')}</Button>
        </div>
      )}
    </div>
  );
};

export default memo(MusicTrackCard);
