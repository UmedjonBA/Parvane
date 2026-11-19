import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import {
  clearQueue, getCurrentTrack, getMusicPlayer, playQueueItem, removeQueueItem, setTrackStarred,
} from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicControls from './MusicControls';
import MusicCover from './MusicCover';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';
import screen from './MusicPlayerScreen.module.scss';

// Parvane (spec 039): плеер и очередь — что играет, управление и треки в порядке проигрывания
type OwnProps = {
  isListOnly?: boolean;
  isExpanded?: boolean;
  onToggleExpanded?: NoneToVoidFunction;
};

const MusicQueue = ({ isListOnly, isExpanded, onToggleExpanded }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const track = getCurrentTrack(player);
  const { upcoming, index } = player.queue;
  const tracks = upcoming.map((id) => player.tracksById[id]).filter(Boolean);

  const handleStar = useLastCallback(() => {
    if (track) void setTrackStarred(track, !track.isStarred);
  });

  if (!tracks.length) {
    return (
      <div className={buildClassName(styles.queue, kit.muted)} data-music-queue="empty">{lang('MusicQueueEmpty')}</div>
    );
  }

  return (
    <div className={styles.queue} data-music-queue={tracks.length}>
      {!isListOnly && track && (
        <div className={styles.now}>
          <MusicCover
            coverId={track.coverId}
            toneId={track.albumId || track.id}
            size={160}
            className={styles.nowCover}
          />
          <div className={styles.nowText}>
            <div className={styles.nowTitle} data-music-now>{track.title}</div>
            <div className={kit.muted}>{track.artist}</div>
          </div>
          <button
            type="button"
            className={buildClassName(kit.btn, track.isStarred && kit.btnAcc)}
            aria-pressed={track.isStarred}
            onClick={handleStar}
          >
            {lang(track.isStarred ? 'MusicUnstar' : 'MusicStar')}
          </button>
        </div>
      )}
      {!isListOnly && player.hasError && <div className={styles.error} role="alert">{lang('MusicPlayError')}</div>}
      {!isListOnly && <MusicControls />}
      <div className={styles.queueHead}>
        {onToggleExpanded ? (
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnGhost)}
            aria-expanded={isExpanded}
            onClick={onToggleExpanded}
          >
            <ParvaneIcon name="list" isSmall />
            {lang('MusicQueueTitle', { count: tracks.length })}
          </button>
        ) : <span className={kit.caps}>{lang('MusicQueueTitle', { count: tracks.length })}</span>}
        <span className={kit.grow} />
        <button type="button" className={kit.btn} onClick={clearQueue}>{lang('MusicQueueClear')}</button>
      </div>
      <ul className={buildClassName(styles.tracks, isListOnly && screen.queueRows, 'custom-scroll')}>
        {tracks.map((item, position) => (
          <MusicTrackRow
            key={`${item.id}:${position}`}
            track={item}
            index={position}
            isCurrent={position === index}
            isPlaying={player.isPlaying}
            canRemove
            onPlay={playQueueItem}
            onRemove={removeQueueItem}
          />
        ))}
      </ul>
    </div>
  );
};

export default memo(MusicQueue);
