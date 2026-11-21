import { memo, useState } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { CloudMenuAnchor } from '../cloud/CloudMenu';
import type { MusicTrackExtra } from './MusicTrackMenu';
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
import MusicOfflineButton from './MusicOfflineButton';
import MusicTrackMenu from './MusicTrackMenu';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

export type MusicRowColumn = 'artist' | 'album' | 'note';

type OwnProps = {
  track: MusicTrack;
  index: number;
  isCurrent?: boolean;
  isPlaying?: boolean;
  // Номер строки вместо обложки (плейлист, альбом, «Популярное»)
  number?: number;
  // Без второй строки: альбом на телефоне (доска `RpMusicA`)
  isBare?: boolean;
  // Во второй строке альбом, а не исполнитель («Популярное» на странице исполнителя, доска `XpMusic`)
  isAlbumLine?: boolean;
  // Компьютер: колонки таблицы после названия (доски `DeskMusic`, `DeskMusicMore`, `ZdMusicX`)
  columns?: MusicRowColumn[];
  // Значок в строке вместо «⋯»: ↓ «Скачать для офлайна» (главная, поиск) либо ♥ «Убрать из любимого» (любимое).
  // Меню остаётся — по правой кнопке и долгому нажатию
  trailing?: 'offline' | 'unstar';
  // Приписка к исполнителю: «добавила Алия»
  note?: string;
  // Вид перед исполнителем: «Трек · Kora Mesh» (найденное, доски `MusicSearch`, `DeskMusicMore`)
  prefix?: string;
  // Плейлист: трека уже нет на сервере — играть нечего
  isMissing?: boolean;
  // Очередь на компьютере: крестик по наведению
  canRemove?: boolean;
  // Без «⋯» в строке: меню — по правой кнопке и долгому нажатию (очередь, доски `MusicPlayer`, `XdMusic`)
  isMenuHidden?: boolean;
  // Очередь и плейлист: ручка перетаскивания с этой подписью
  dragLabel?: string;
  dragState?: DragRowState;
  drag?: DragHandlers;
  // Меню трека: «Играть следующим» и «В конец очереди»
  canQueue?: boolean;
  // Меню трека: «Скачать для офлайна / Убрать с устройства»
  canSaveOffline?: boolean;
  // Пункты меню по месту строки: убрать, переставить
  extra?: MusicTrackExtra;
  onDelete?: (track: MusicTrack) => void;
  onPlay: (index: number) => void;
  onStar?: (track: MusicTrack) => void;
  onRemove?: (index: number) => void;
  onSendToChat?: (track: MusicTrack) => void;
};

const DRAG_STATE_CLASSES = {
  dragged: styles.trackDragged,
  above: styles.trackOver,
  below: styles.trackOverBelow,
} as const;
// Уже — телефон: меню трека шторкой снизу, шире — у курсора
const PHONE_MAX_WIDTH = 925;

// Parvane (spec 039, 041): строка трека — обложка либо номер, название и исполнитель (на компьютере — колонками),
// длительность; нажатие играет. Действия — в меню «⋯» (и по правой кнопке, долгому нажатию)
const MusicTrackRow = ({
  track, index, isCurrent, isPlaying, number, isBare, isAlbumLine, columns, trailing, note, prefix, isMissing,
  canRemove, isMenuHidden, dragLabel, dragState, drag, canQueue, canSaveOffline, extra,
  onPlay, onStar, onRemove, onDelete, onSendToChat,
}: OwnProps) => {
  const lang = useLang();
  // Меню открыто: точка у курсора на компьютере, `{}` — шторка на телефоне
  const [menu, setMenu] = useState<{ anchor?: CloudMenuAnchor }>();
  const offline = useDerivedState(getOfflineState);

  const canQueueHere = canQueue && !isMissing;
  const canSaveHere = canSaveOffline && !isMissing;
  const hasMenu = Boolean(canQueueHere || canSaveHere || onStar || onSendToChat || onDelete || extra?.onRemove);
  const offlineState = !canSaveHere ? undefined
    : offline.entries.some((entry) => entry.track.id === track.id) ? 'saved'
      : offline.pending > 0 && isTrackSaving(track.id) ? 'saving' : 'none';

  const handlePlay = useLastCallback(() => onPlay(index));
  const handleRemove = useLastCallback(() => onRemove?.(index));
  const handleCloseMenu = useLastCallback(() => setMenu(undefined));
  const handleUnstar = useLastCallback(() => onStar?.(track));

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

  const isTable = Boolean(columns?.length);
  // Отметка играющего — и на паузе (доски `DeskMusic`, `XdMusic`: «Lampa · играет»)
  const nowPlaying = isCurrent && lang('MusicNowPlaying');
  const artistLine = [prefix, isAlbumLine ? track.album : track.artist, isTable ? undefined : note, nowPlaying]
    .filter(Boolean).join(' · ');
  const cells: Record<MusicRowColumn, string | undefined> = { artist: track.artist, album: track.album, note };

  return (
    <li
      className={buildClassName(
        styles.track,
        isCurrent && styles.trackCurrent,
        isTable && styles.trackTable,
        (canRemove || drag) && styles.trackHoverTools,
        dragState && DRAG_STATE_CLASSES[dragState],
      )}
      data-track={track.id}
      data-music-current={isCurrent ? true : undefined}
      data-drag-row={drag ? true : undefined}
      data-music-offline-track={offlineState}
      onContextMenu={handleContextMenu}
    >
      <button type="button" className={styles.trackMain} disabled={isMissing} onClick={handlePlay}>
        {number !== undefined ? (
          <span className={buildClassName(styles.trackNo, kit.mono, kit.muted, kit.small)}>{number}</span>
        ) : (
          <MusicCover
            coverId={track.coverId}
            toneId={track.albumId || track.id}
            size={40}
            className={styles.trackCover}
          />
        )}
        <span className={styles.trackText}>
          <span className={styles.trackTitle}>{track.title}</span>
          {!isBare && (
            <span
              className={buildClassName(kit.muted, kit.small, styles.trackArtist, isTable && styles.trackSecondary)}
            >
              {artistLine}
            </span>
          )}
        </span>
        {columns?.map((column) => (
          <span key={column} className={buildClassName(styles.trackCell, kit.muted, kit.small)}>{cells[column]}</span>
        ))}
        {offlineState === 'saved' && trailing !== 'offline' && (
          <ParvaneIcon name="downloaded" isSmall className={styles.trackSaved} />
        )}
        <span className={buildClassName(kit.mono, kit.muted, kit.small)}>{formatTrackTime(track.durationSecs)}</span>
      </button>
      {trailing === 'offline' && canSaveHere && <MusicOfflineButton track={track} />}
      {trailing === 'unstar' && (
        <button
          type="button"
          className={buildClassName(kit.ib, styles.starOn)}
          aria-label={lang('MusicUnstar')}
          aria-pressed
          data-music-unstar
          onClick={handleUnstar}
        >
          <ParvaneIcon name="heart" isSmall className={styles.heartFilled} />
        </button>
      )}
      {hasMenu && !isMenuHidden && (
        <button
          type="button"
          className={buildClassName(kit.ib, trailing && styles.menuHidden, isTable && styles.hoverOnly)}
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
          className={buildClassName(kit.ib, styles.hoverOnly)}
          aria-label={lang('MusicQueueRemove', { name: track.title })}
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
          extra={extra}
          onStar={onStar}
          onSendToChat={onSendToChat}
          onDelete={onDelete}
          onClose={handleCloseMenu}
        />
      )}
    </li>
  );
};

export default memo(MusicTrackRow);
