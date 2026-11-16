import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from './musicFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  track: MusicTrack;
  index: number;
  isCurrent?: boolean;
  isPlaying?: boolean;
  // Очередь: трек убирается крестиком
  canRemove?: boolean;
  onPlay: (index: number) => void;
  onStar?: (track: MusicTrack) => void;
  onAddNext?: (track: MusicTrack) => void;
  onRemove?: (index: number) => void;
};

// Parvane (spec 039): строка трека — обложка, название и исполнитель, длительность; нажатие играет
const MusicTrackRow = ({
  track, index, isCurrent, isPlaying, canRemove, onPlay, onStar, onAddNext, onRemove,
}: OwnProps) => {
  const lang = useLang();

  const handlePlay = useLastCallback(() => onPlay(index));
  const handleStar = useLastCallback(() => onStar?.(track));
  const handleAddNext = useLastCallback(() => onAddNext?.(track));
  const handleRemove = useLastCallback(() => onRemove?.(index));

  return (
    <li className={buildClassName(styles.track, isCurrent && styles.trackCurrent)} data-track={track.id}>
      <button type="button" className={styles.trackMain} onClick={handlePlay}>
        <MusicCover
          coverId={track.coverId}
          toneId={track.albumId || track.id}
          size={40}
          className={styles.trackCover}
        />
        <span className={styles.trackText}>
          <span className={styles.trackTitle}>{track.title}</span>
          <span className={buildClassName(kit.muted, kit.small, styles.trackArtist)}>
            {isCurrent && isPlaying ? `${track.artist} · ${lang('MusicNowPlaying')}` : track.artist}
          </span>
        </span>
        <span className={buildClassName(kit.mono, kit.muted, kit.small)}>{formatTrackTime(track.durationSecs)}</span>
      </button>
      {onStar && (
        <button
          type="button"
          className={buildClassName(kit.ib, track.isStarred && styles.starOn)}
          aria-label={lang(track.isStarred ? 'MusicUnstar' : 'MusicStar')}
          aria-pressed={track.isStarred}
          onClick={handleStar}
        >
          <ParvaneIcon name="heart" isSmall />
        </button>
      )}
      {onAddNext && (
        <button type="button" className={kit.ib} aria-label={lang('MusicPlayNext')} onClick={handleAddNext}>
          <ParvaneIcon name="plus" isSmall />
        </button>
      )}
      {canRemove && (
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('MusicQueueRemove', { name: track.title })}
          onClick={handleRemove}
        >
          <ParvaneIcon name="close" isSmall />
        </button>
      )}
    </li>
  );
};

export default memo(MusicTrackRow);
