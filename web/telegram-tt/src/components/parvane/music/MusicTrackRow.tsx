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
  // Приписка к исполнителю: «добавила Алия»
  note?: string;
  // Плейлист: трека уже нет на сервере — играть нечего
  isMissing?: boolean;
  // Подпись крестика вместо «убрать из очереди»
  removeLabel?: string;
  // Плейлист: индекс последней строки — у крайних строк стрелка выключена
  lastIndex?: number;
  // «Загруженное»: убрать трек из библиотеки сервера
  onDelete?: (track: MusicTrack) => void;
  onPlay: (index: number) => void;
  onStar?: (track: MusicTrack) => void;
  onAddNext?: (track: MusicTrack) => void;
  onRemove?: (index: number) => void;
  onAddToPlaylist?: (track: MusicTrack) => void;
  onSendToChat?: (track: MusicTrack) => void;
  // Плейлист: переставить строку на место `toIndex`
  onMove?: (index: number, toIndex: number) => void;
};

// Parvane (spec 039): строка трека — обложка, название и исполнитель, длительность; нажатие играет
const MusicTrackRow = ({
  track, index, isCurrent, isPlaying, canRemove, note, isMissing, removeLabel, lastIndex,
  onPlay, onStar, onAddNext, onRemove, onDelete, onAddToPlaylist, onSendToChat, onMove,
}: OwnProps) => {
  const lang = useLang();

  const handlePlay = useLastCallback(() => onPlay(index));
  const handleStar = useLastCallback(() => onStar?.(track));
  const handleAddNext = useLastCallback(() => onAddNext?.(track));
  const handleRemove = useLastCallback(() => onRemove?.(index));
  const handleDelete = useLastCallback(() => onDelete?.(track));
  const handleAddToPlaylist = useLastCallback(() => onAddToPlaylist?.(track));
  const handleSendToChat = useLastCallback(() => onSendToChat?.(track));
  const handleMoveUp = useLastCallback(() => onMove?.(index, index - 1));
  const handleMoveDown = useLastCallback(() => onMove?.(index, index + 1));
  const nowPlaying = isCurrent && isPlaying && lang('MusicNowPlaying');
  const artistLine = [track.artist, note, nowPlaying].filter(Boolean).join(' · ');

  return (
    <li className={buildClassName(styles.track, isCurrent && styles.trackCurrent)} data-track={track.id}>
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
      {onMove && (
        <>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('MusicPlaylistMoveUp', { name: track.title })}
            disabled={index === 0}
            onClick={handleMoveUp}
          >
            <ParvaneIcon name="left" isSmall className={styles.turnUp} />
          </button>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('MusicPlaylistMoveDown', { name: track.title })}
            disabled={index === lastIndex}
            onClick={handleMoveDown}
          >
            <ParvaneIcon name="left" isSmall className={styles.turnDown} />
          </button>
        </>
      )}
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
    </li>
  );
};

export default memo(MusicTrackRow);
