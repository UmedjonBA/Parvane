import { memo, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { CloudMenuAnchor } from '../cloud/CloudMenu';
import type { DragHandlers, DragRowState } from './useDragReorder';

import buildClassName from '../../../util/buildClassName';
import { formatTrackTime } from './musicFormat';
import { getOfflineState, isTrackSaving } from './musicOffline';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvIcon from '../notes/PvIcon';
import MusicCover from './MusicCover';
import MusicTrackMenu from './MusicTrackMenu';

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
  // Меню трека: «Играть следующим» и «В конец очереди»
  canQueue?: boolean;
  // Меню трека: «Скачать для офлайна / Убрать с устройства» (доски `XpMusic`, `MusicChat`)
  canSaveOffline?: boolean;
  // «Загруженное»: убрать трек из библиотеки сервера
  onDelete?: (track: MusicTrack) => void;
  onPlay: (index: number) => void;
  onStar?: (track: MusicTrack) => void;
  onRemove?: (index: number) => void;
  onAddToPlaylist?: (track: MusicTrack) => void;
  onSendToChat?: (track: MusicTrack) => void;
};

const DRAG_STATE_CLASSES = {
  dragged: styles.trackDragged,
  above: styles.trackOver,
  below: styles.trackOverBelow,
} as const;
// Уже — телефон: меню трека шторкой снизу, шире — у курсора (как в стилях «Музыки»)
const PHONE_MAX_WIDTH = 925;

// Parvane (spec 039, 041): строка трека — обложка, название и исполнитель, длительность; нажатие играет.
// Действия — в меню «⋯» (и по правой кнопке); в строке остаются только крестик и ручка очереди и плейлиста
const MusicTrackRow = ({
  track, index, isCurrent, isPlaying, canRemove, note, isMissing, removeLabel, dragLabel, dragState, drag,
  canQueue, canSaveOffline, onPlay, onStar, onRemove, onDelete, onAddToPlaylist, onSendToChat,
}: OwnProps) => {
  const lang = useLang();
  // Меню открыто: точка у курсора на компьютере, `{}` — шторка на телефоне
  const [menu, setMenu] = useState<{ anchor?: CloudMenuAnchor }>();
  const offline = useDerivedState(getOfflineState);

  const canQueueHere = canQueue && !isMissing;
  const canSaveHere = canSaveOffline && !isMissing;
  const hasMenu = Boolean(canQueueHere || canSaveHere || onStar || onAddToPlaylist || onSendToChat || onDelete);
  const offlineState = !canSaveHere ? undefined
    : offline.entries.some((entry) => entry.track.id === track.id) ? 'saved'
      : offline.pending > 0 && isTrackSaving(track.id) ? 'saving' : 'none';

  const handlePlay = useLastCallback(() => onPlay(index));
  const handleRemove = useLastCallback(() => onRemove?.(index));
  const handleCloseMenu = useLastCallback(() => setMenu(undefined));

  const openMenu = (x: number, y: number) => {
    setMenu({ anchor: window.innerWidth <= PHONE_MAX_WIDTH ? undefined : { x, y } });
  };

  const handleMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    openMenu(box.left, box.bottom);
  });

  const handleContextMenu = useLastCallback((e: React.MouseEvent) => {
    if (!hasMenu) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  });

  const nowPlaying = isCurrent && isPlaying && lang('MusicNowPlaying');
  const artistLine = [track.artist, note, nowPlaying].filter(Boolean).join(' · ');

  return (
    <li
      className={buildClassName(
        styles.track, isCurrent && styles.trackCurrent, dragState && DRAG_STATE_CLASSES[dragState],
      )}
      data-track={track.id}
      data-drag-row={drag ? true : undefined}
      data-music-offline-track={offlineState}
      onContextMenu={handleContextMenu}
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
        {offlineState === 'saved' && (
          <ParvaneIcon name="downloaded" isSmall className={styles.trackSaved} />
        )}
        <span className={buildClassName(kit.mono, kit.muted, kit.small)}>{formatTrackTime(track.durationSecs)}</span>
      </button>
      {hasMenu && (
        <button
          type="button"
          className={kit.ib}
          aria-label={lang('MusicTrackActions', { name: track.title })}
          aria-haspopup="menu"
          data-music-menu
          onClick={handleMenu}
        >
          <PvIcon name="dots" isSmall />
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
      {menu && (
        <MusicTrackMenu
          track={track}
          anchor={menu.anchor}
          note={note}
          canQueue={canQueueHere}
          canSaveOffline={canSaveHere}
          onStar={onStar}
          onAddToPlaylist={onAddToPlaylist}
          onSendToChat={onSendToChat}
          onDelete={onDelete}
          onClose={handleCloseMenu}
        />
      )}
    </li>
  );
};

export default memo(MusicTrackRow);
