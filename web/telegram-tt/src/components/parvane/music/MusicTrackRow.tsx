import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { DragHandlers, DragRowState } from './useDragReorder';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from './musicFormat';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';
import MusicOfflineButton from './MusicOfflineButton';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  track: MusicTrack;
  index: number;
  isCurrent?: boolean;
  isPlaying?: boolean;
  // Очередь: трек убирается крестиком
  canRemove?: boolean;
  // Приписка к исполнителю: «добавила Алия»
  note?: string;
  // Плейлист: трека уже нет на сервере — играть нечего
  isMissing?: boolean;
  // Подпись крестика вместо «убрать из очереди»
  removeLabel?: string;
  // Очередь и плейлист: ручка перетаскивания с этой подписью
  dragLabel?: string;
  dragState?: DragRowState;
  drag?: DragHandlers;
  // Кнопка «загрузить на устройство» (доски `XpMusic`, `MusicChat`)
  canSaveOffline?: boolean;
  // «Загруженное»: убрать трек из библиотеки сервера
  onDelete?: (track: MusicTrack) => void;
  onPlay: (index: number) => void;
  onStar?: (track: MusicTrack) => void;
  onAddNext?: (track: MusicTrack) => void;
  onRemove?: (index: number) => void;
  onAddToPlaylist?: (track: MusicTrack) => void;
  onSendToChat?: (track: MusicTrack) => void;
};

const DRAG_STATE_CLASSES = {
  dragged: styles.trackDragged,
  above: styles.trackOver,
  below: styles.trackOverBelow,
} as const;

// Parvane (spec 039): строка трека — обложка, название и исполнитель, длительность; нажатие играет
const MusicTrackRow = ({
  track, index, isCurrent, isPlaying, canRemove, note, isMissing, removeLabel, dragLabel, dragState, drag,
  canSaveOffline, onPlay, onStar, onAddNext, onRemove, onDelete, onAddToPlaylist, onSendToChat,
}: OwnProps) => {
  const lang = useLang();

  const handlePlay = useLastCallback(() => onPlay(index));
  const handleStar = useLastCallback(() => onStar?.(track));
  const handleAddNext = useLastCallback(() => onAddNext?.(track));
  const handleRemove = useLastCallback(() => onRemove?.(index));
  const handleDelete = useLastCallback(() => onDelete?.(track));
  const handleAddToPlaylist = useLastCallback(() => onAddToPlaylist?.(track));
  const handleSendToChat = useLastCallback(() => onSendToChat?.(track));
  const nowPlaying = isCurrent && isPlaying && lang('MusicNowPlaying');
  const artistLine = [track.artist, note, nowPlaying].filter(Boolean).join(' · ');

  return (
    <li
      className={buildClassName(
        styles.track, isCurrent && styles.trackCurrent, dragState && DRAG_STATE_CLASSES[dragState],
      )}
      data-track={track.id}
      data-drag-row={drag ? true : undefined}
    >
      <button type="button" className={styles.trackMain} disabled={isMissing} onClick={handlePlay}>
        <MusicCover
          coverId={track.coverId}
          toneId={track.albumId || track.id}
          size={40}
          className={styles.trackCover}
        />
        <span className={styles.trackText}>
          <span className={styles.trackTitle}>{track.title}</span>
          <span className={buildClassName(kit.muted, kit.small, styles.trackArtist)}>
            {artistLine}
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
      {onAddToPlaylist && (
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('MusicAddToPlaylist')}
          data-music-to-playlist
          onClick={handleAddToPlaylist}
        >
          <ParvaneIcon name="list" isSmall />
        </button>
      )}
      {onSendToChat && (
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('MusicSendToChat')}
          data-music-to-chat
          onClick={handleSendToChat}
        >
          <ParvaneIcon name="chat" isSmall />
        </button>
      )}
      {canSaveOffline && !isMissing && <MusicOfflineButton track={track} />}
      {onDelete && (
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('MusicAddedDelete', { name: track.title })}
          data-music-delete
          onClick={handleDelete}
        >
          <ParvaneIcon name="close" isSmall />
        </button>
      )}
      {canRemove && (
        <button
          type="button"
          className={kit.ib}
          aria-label={removeLabel || lang('MusicQueueRemove', { name: track.title })}
          onClick={handleRemove}
        >
          <ParvaneIcon name="close" isSmall />
        </button>
      )}
      {drag && (
        <button
          type="button"
          className={styles.handle}
          aria-label={dragLabel}
          data-index={index}
          data-music-drag
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
          onKeyDown={drag.onKeyDown}
        >
          <ParvaneIcon name="grip" isSmall className={styles.handleIcon} />
        </button>
      )}
    </li>
  );
};

export default memo(MusicTrackRow);
