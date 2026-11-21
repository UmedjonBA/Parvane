import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import {
  clearQueue, getMusicPlayer, moveQueueItem, playQueueItem, removeQueueItem, setTrackStarred,
} from './musicPlayer';
import useDragReorder from './useDragReorder';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';
import screen from './MusicPlayerScreen.module.scss';

type OwnProps = {
  // Телефон, полный плеер: «Далее в очереди» — только треки после играющего (доска `MusicPlayer`)
  isUpcomingOnly?: boolean;
  // Полный плеер на телефоне: подпись раскрывает очередь на весь экран
  isExpanded?: boolean;
  onToggleExpanded?: NoneToVoidFunction;
};

// Parvane (spec 039, 041; доски `DeskMusic`, `XdMusic`, `MusicPlayer`): очередь — треки в порядке проигрывания,
// «Очистить» ссылкой, перестановка за ручку. На компьютере крестик и ручка — по наведению; на телефоне убрать —
// пунктом меню строки (долгое нажатие). Порядок ведёт движок (MUSIC-1)
const MusicQueue = ({ isUpcomingOnly, isExpanded, onToggleExpanded }: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const { upcoming, index } = player.queue;
  const tracks = upcoming.map((id) => player.tracksById[id]).filter(Boolean);
  // Место строки в порядке проигрывания: на телефоне сыгранные и играющий не показываются
  const first = isUpcomingOnly ? index + 1 : 0;
  const shown = tracks.slice(first);
  const handleMove = useLastCallback((from: number, to: number) => moveQueueItem(from + first, to + first));
  const { handlers: drag, getRowState } = useDragReorder(shown.length, handleMove);

  const handlePlay = useLastCallback((position: number) => playQueueItem(position + first));
  const handleRemove = useLastCallback((position: number) => removeQueueItem(position + first));
  // «В любимое» — в меню любой строки трека (доска `XpMusic`)
  const handleStar = useLastCallback((track: MusicTrack) => void setTrackStarred(track, !track.isStarred));

  if (!tracks.length) {
    return (
      <div className={buildClassName(styles.queue, kit.muted)} data-music-queue="empty">{lang('MusicQueueEmpty')}</div>
    );
  }

  const title = lang(isUpcomingOnly ? 'MusicQueueUpcoming' : 'MusicQueueTitle', { count: shown.length });
  return (
    <div className={styles.queue} data-music-queue={tracks.length}>
      <div className={styles.queueHead}>
        {onToggleExpanded ? (
          <button
            type="button"
            className={buildClassName(kit.caps, styles.queueToggle)}
            aria-expanded={isExpanded}
            onClick={onToggleExpanded}
          >
            {title}
          </button>
        ) : <span className={kit.caps}>{title}</span>}
        <span className={kit.grow} />
        <button
          type="button"
          className={styles.linkButton}
          aria-label={lang('MusicQueueClearLabel')}
          onClick={clearQueue}
        >
          {lang('MusicQueueClear')}
        </button>
      </div>
      <ul className={buildClassName(styles.tracks, screen.queueRows, 'custom-scroll')}>
        {shown.map((item, position) => (
          <MusicTrackRow
            key={`${item.id}:${position + first}`}
            track={item}
            index={position}
            isCurrent={position + first === index}
            isPlaying={player.isPlaying}
            canRemove={!isUpcomingOnly}
            isMenuHidden
            extra={{
              removeLabel: lang('MusicQueueRemoveItem'),
              onRemove: () => handleRemove(position),
            }}
            dragLabel={lang('MusicQueueDrag', { name: item.title })}
            dragState={getRowState(position)}
            drag={drag}
            onPlay={handlePlay}
            onRemove={handleRemove}
            onStar={handleStar}
          />
        ))}
      </ul>
    </div>
  );
};

export default memo(MusicQueue);
