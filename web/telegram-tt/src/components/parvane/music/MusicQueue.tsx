import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicQueueSource } from './musicPlayer';

import buildClassName from '../../../util/buildClassName';
import {
  clearAddedToQueue, cycleRepeat, getMusicPlayer, playQueueItem, removeQueueItem, setTrackStarred, toggleShuffle,
} from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicTrackRow from './MusicTrackRow';

import styles from './MusicQueue.module.scss';

type OwnProps = {
  // Шторка полного плеера телефона: заголовок со стрелкой вниз и кнопки внизу (доска `MusicPlayer-06`);
  // без неё — страница «Очередь» на компьютере (доска `XdMusic-01`)
  isSheet?: boolean;
  onClose?: NoneToVoidFunction;
  onToPlaylist?: (tracks: MusicTrack[]) => void;
};

// «Далее из: …» по виду источника: с названием источника и без него
const SOURCE_NAMED_KEYS = {
  playlist: 'MusicNextFromPlaylist',
  album: 'MusicNextFromAlbum',
  artist: 'MusicNextFromArtist',
  search: 'MusicNextFromSearch',
  home: 'MusicNextFromHome',
} as const;
const SOURCE_PLAIN_KEYS = {
  starred: 'MusicNextFromStarred',
  offline: 'MusicNextFromOffline',
  chat: 'MusicNextFromChat',
} as const;

// Parvane (макет «Музыки» 23 ноя, доски `MusicPlayer-06`, `XdMusic-01`): очередь — «Сейчас играет», «Далее в
// очереди · вы добавили» с «Очистить» (то, что человек поставил сам, играет раньше источника) и «Далее из: …».
// Сколько добавлено человеком, знает очередь движка (MUSIC-1)
const MusicQueue = ({ isSheet, onClose, onToPlaylist }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const {
    upcoming, index, added, shuffle, repeat,
  } = player.queue;
  const tracks = upcoming.map((id) => player.tracksById[id]);
  const current = index >= 0 ? tracks[index] : undefined;
  const addedStart = index + 1;
  const addedEnd = addedStart + (added || 0);
  const sourceName = player.source?.name || (player.source?.kind === 'starred' ? lang('MusicStarred') : undefined);

  const handlePlay = useLastCallback((position: number) => playQueueItem(position));
  const handleRemove = useLastCallback((position: number) => removeQueueItem(position));
  const handleStar = useLastCallback((track: MusicTrack) => void setTrackStarred(track, !track.isStarred));
  const handleToPlaylist = useLastCallback(() => {
    onToPlaylist?.(tracks.slice(Math.max(0, index)).filter(Boolean));
  });

  function renderRows(from: number, to: number) {
    const rows = [];
    for (let position = from; position < to; position++) {
      const track = tracks[position];
      if (!track) continue;
      rows.push(
        <MusicTrackRow
          key={`${track.id}:${position}`}
          track={track}
          index={position}
          rank={isSheet ? undefined : position - index}
          isCurrent={position === index}
          isPlaying={player.isPlaying}
          columns={isSheet ? undefined : ['album']}
          extra={{ removeLabel: lang('MusicQueueRemoveItem'), onRemove: () => handleRemove(position) }}
          onPlay={handlePlay}
          onStar={handleStar}
        />,
      );
    }
    return <ul className={styles.rows}>{rows}</ul>;
  }

  function renderSourceCaps(kind: MusicQueueSource['kind']) {
    if (kind in SOURCE_PLAIN_KEYS) return lang(SOURCE_PLAIN_KEYS[kind as keyof typeof SOURCE_PLAIN_KEYS]);
    return lang(SOURCE_NAMED_KEYS[kind as keyof typeof SOURCE_NAMED_KEYS], { name: sourceName || '' });
  }

  const hasAdded = addedEnd > addedStart;
  const hasRest = tracks.length > addedEnd;

  return (
    <div className={buildClassName(styles.root, isSheet && styles.rootSheet)} data-music-queue={tracks.length}>
      <div className={styles.head}>
        <h2 className={styles.title}>{lang('MusicQueue')}</h2>
        {onClose && (
          <button type="button" className={styles.close} aria-label={lang('Close')} onClick={onClose}>
            <ParvaneIcon name="chevronDown" />
          </button>
        )}
      </div>
      {!current && !hasRest && <div className={styles.empty}>{lang('MusicQueueEmpty')}</div>}
      {current && (
        <section className={styles.section}>
          <div className={styles.caps}>{lang('MusicNowPlayingCaps')}</div>
          {renderRows(index, index + 1)}
        </section>
      )}
      {hasAdded && (
        <section className={styles.section} data-music-queue-added={addedEnd - addedStart}>
          <div className={styles.capsRow}>
            <span className={styles.caps}>{lang('MusicQueueAddedCaps')}</span>
            <button
              type="button"
              className={styles.link}
              aria-label={lang('MusicQueueClearLabel')}
              data-music-queue-clear
              onClick={clearAddedToQueue}
            >
              {lang('MusicQueueClear')}
            </button>
          </div>
          {renderRows(addedStart, addedEnd)}
        </section>
      )}
      {hasRest && (
        <section className={styles.section}>
          <div className={styles.caps}>
            {renderSourceCaps(player.source?.kind || 'home')}
          </div>
          {renderRows(addedEnd, tracks.length)}
        </section>
      )}
      {isSheet && (
        <div className={styles.bottom}>
          <button
            type="button"
            className={buildClassName(styles.pill, shuffle && styles.pillOn)}
            aria-pressed={shuffle}
            onClick={toggleShuffle}
          >
            <ParvaneIcon name="shuffle" isSmall />
            {lang('MusicShuffleShort')}
          </button>
          <button
            type="button"
            className={buildClassName(styles.pill, repeat !== 'off' && styles.pillOn)}
            aria-pressed={repeat !== 'off'}
            onClick={cycleRepeat}
          >
            <ParvaneIcon name="repeat" isSmall />
            {lang('MusicRepeatShort')}
          </button>
          {onToPlaylist && (
            <button type="button" className={styles.pill} onClick={handleToPlaylist}>
              {lang('MusicToPlaylist')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default memo(MusicQueue);
