import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { CloudMenuAnchor } from '../cloud/CloudMenu';
import type { MusicMenuAction } from './MusicMenu';

import { copyTextToClipboard } from '../../../util/clipboard';
import {
  addTracksToShared, canEditTracks, getSharedPlaylists, refreshSharedPlaylists, toTrackInput,
} from './shared/musicShared';
import { canDeleteTrack, deleteLibraryTrack, getOwnAdded } from './musicAdded';
import { formatTrackTime } from './musicFormat';
import { goToMusic } from './musicGoTo';
import {
  getOfflineState, isTrackSaving, removeOffline, saveTracksOffline,
} from './musicOffline';
import { addToQueue, callMusic } from './musicPlayer';
import { addTracksToPlaylist, getPlaylists, refreshPlaylists } from './musicPlaylists';
import { openNewPlaylist } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';
import MusicMenu from './MusicMenu';
import MusicPlaylistPicker from './MusicPlaylistPicker';

import sheets from '../cloud/CloudSheets.module.scss';
import music from './Music.module.scss';

export type MusicTrackExtra = {
  // «Убрать из плейлиста», «Убрать из очереди», «Убрать с устройства»
  removeLabel?: string;
  onRemove?: NoneToVoidFunction;
  // Порядок плейлиста на телефоне (на компьютере — перетаскивание за ручку)
  onMoveUp?: NoneToVoidFunction;
  onMoveDown?: NoneToVoidFunction;
};

type OwnProps = {
  track: MusicTrack;
  // Компьютер: меню у этой точки; без неё — шторка снизу (телефон)
  anchor?: CloudMenuAnchor;
  // Приписка «добавил(а) …» — в строке сведений
  note?: string;
  canQueue?: boolean;
  canSaveOffline?: boolean;
  extra?: MusicTrackExtra;
  onStar?: (track: MusicTrack) => void;
  onSendToChat?: (track: MusicTrack) => void;
  // «Удалить из библиотеки сервера» своим обработчиком («Добавлено мной»); без него — общий, если трек добавил сам
  // пользователь либо он администратор
  onDelete?: (track: MusicTrack) => void;
  onClose: NoneToVoidFunction;
};

const PLAYLIST_PREFIX = 'playlist:';
// Общий плейлист, где можно добавлять (MUSIC-3)
const SHARED_PREFIX = 'shared:';
const NEW_PLAYLIST = 'playlist-new';

// Меню трека (доски `XpMusic` — шторка телефона, `ZdMusicX` — меню у курсора на компьютере): очередь, плейлист,
// любимое, переходы, чат, трек на устройстве, удаление из библиотеки сервера. Состав и подписи — по доске своего
// устройства; пункт есть, только если его действие доступно там, где стоит строка
const MusicTrackMenu = ({
  track, anchor, note, canQueue, canSaveOffline, extra, onStar, onSendToChat, onDelete, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const offline = useDerivedState(getOfflineState);
  const playlists = useDerivedState(getPlaylists);
  const shared = useDerivedState(getSharedPlaylists).filter((playlist) => canEditTracks(playlist.myRole));
  // Перерисовка, когда стали известны свои добавленные треки
  useDerivedState(getOwnAdded);
  const canDelete = Boolean(onDelete) || canDeleteTrack(track.id);
  const isSaved = offline.entries.some((entry) => entry.track.id === track.id);
  const isSaving = !isSaved && offline.pending > 0 && isTrackSaving(track.id);
  const isDesk = Boolean(anchor);
  const [isPicking, setIsPicking] = useState(false);

  useEffect(() => {
    if (!isDesk) return;
    void refreshPlaylists();
    void refreshSharedPlaylists();
  }, [isDesk]);

  const addTo = useLastCallback(async (playlistId: string) => {
    const name = playlists.find((item) => item.id === playlistId)?.name || '';
    const result = await addTracksToPlaylist(playlistId, [track]);
    const message = !result ? lang('MusicPlaylistFailed')
      : result.skipped ? lang('MusicPlaylistAlreadyThere') : lang('MusicAddedTo', { name });
    showNotification({ message });
  });

  const addToShared = useLastCallback(async (playlistId: string) => {
    const name = shared.find((item) => item.id === playlistId)?.name || '';
    const skipped = await addTracksToShared(playlistId, [toTrackInput(track)]);
    const message = skipped === undefined ? lang('MusicPlaylistFailed')
      : skipped ? lang('MusicPlaylistAlreadyThere') : lang('MusicAddedTo', { name });
    showNotification({ message });
  });

  const handlePick = useLastCallback((key: string) => {
    // Телефон: «В плейлист» — выбор плейлиста вместо меню
    if (key === 'playlist') {
      setIsPicking(true);
      return;
    }
    onClose();
    if (key.startsWith(PLAYLIST_PREFIX)) {
      void addTo(key.slice(PLAYLIST_PREFIX.length));
      return;
    }
    if (key.startsWith(SHARED_PREFIX)) {
      void addToShared(key.slice(SHARED_PREFIX.length));
      return;
    }
    const run: Record<string, NoneToVoidFunction> = {
      next: () => {
        addToQueue([track], true);
        showNotification({ message: lang('MusicQueuedNext', { name: track.title }) });
      },
      queue: () => addToQueue([track], false),
      star: () => onStar?.(track),
      [NEW_PLAYLIST]: () => openNewPlaylist(track),
      chat: () => onSendToChat?.(track),
      offline: () => (isSaved ? void removeOffline([track.id]) : saveTracksOffline([track])),
      artist: () => goToMusic({ kind: 'artist', id: track.artistId }),
      album: () => goToMusic({ kind: 'album', id: track.albumId }),
      remove: () => extra?.onRemove?.(),
      up: () => extra?.onMoveUp?.(),
      down: () => extra?.onMoveDown?.(),
      delete: () => (onDelete ? onDelete(track) : void deleteLibraryTrack(track.id)),
      dislike: () => void dislike({ trackId: track.id, artist: track.artist, title: track.title }),
      share: () => void shareTrack(),
    };
    run[key]?.();
  });

  // «Поделиться»: системное меню, где оно есть, иначе название и исполнитель — в буфер обмена
  async function shareTrack() {
    const text = `${track.title} — ${track.artist}`;
    if (navigator.share) {
      await navigator.share({ text }).catch(() => undefined);
      return;
    }
    copyTextToClipboard(text);
    showNotification({ message: lang('MusicShareCopied') });
  }

  // «Не нравится»: трек либо исполнитель больше не предлагается в «Миксе дня»
  async function dislike(target: { trackId?: string; artist: string; title?: string }) {
    const isDone = await callMusic('parvaneMusicDislike', target).then(() => true, () => false);
    showNotification({ message: lang(isDone ? 'MusicDisliked' : 'MusicPlaylistFailed') });
  }

  const item = (
    key: string, icon: ParvaneIconName, title: string, more?: Partial<MusicMenuAction>,
  ): MusicMenuAction => ({
    key, title, glyph: <ParvaneIcon name={icon} className={sheets.menuIcon} />, ...more,
  });

  const offlineKey = isSaved ? 'MusicOfflineRemoveTrack' : isSaving ? 'MusicOfflineSaving'
    : isDesk ? 'MusicOfflineSaveDesk' : 'MusicOfflineSaveTrack';
  const playlistSubmenu = [
    ...playlists.map((playlist) => ({ key: `${PLAYLIST_PREFIX}${playlist.id}`, title: playlist.name })),
    ...shared.map((playlist) => ({ key: `${SHARED_PREFIX}${playlist.id}`, title: playlist.name })),
    { key: NEW_PLAYLIST, title: lang('MusicPlaylistChipNew') },
  ];
  // Доска `RpMusicA`: «В Любимом · В плейлист · В очередь · Поделиться» — кругами на телефоне, первыми пунктами
  // меню у курсора на компьютере
  const quick = [
    onStar && item('star', 'heart', lang(track.isStarred ? 'MusicInFavourites' : 'MusicStarShort'), {
      isOn: track.isStarred,
    }),
    item('playlist', 'plus', lang('MusicToPlaylist'), isDesk ? { submenu: playlistSubmenu } : undefined),
    canQueue && item('next', 'list', lang('MusicToQueue')),
    item('share', 'share', lang('MusicShare')),
  ].filter((action): action is MusicMenuAction => Boolean(action));
  const fileMenu = [
    canDelete && item('delete', 'trash', lang('MusicDeleteFromServer'), { isDanger: true }),
  ].filter((action): action is MusicMenuAction => Boolean(action));
  const actions = [
    onSendToChat && item('chat', 'send', lang(isDesk ? 'MusicSendToChatDesk' : 'MusicSendToChat'), {
      hasDivider: isDesk,
    }),
    track.artistId && item('artist', 'mic', lang(isDesk ? 'MusicGoToArtistDesk' : 'MusicGoToArtist')),
    track.albumId && item('album', 'disc', lang(isDesk ? 'MusicGoToAlbumDesk' : 'MusicGoToAlbum')),
    canSaveOffline && item('offline', isSaved ? 'downloaded' : 'offline', lang(offlineKey), { isDisabled: isSaving }),
    extra?.onMoveUp && item('up', 'chevronUp', lang('MusicMoveUp')),
    extra?.onMoveDown && item('down', 'chevronDown', lang('MusicMoveDown')),
    extra?.onRemove && extra.removeLabel && item('remove', 'close', extra.removeLabel),
    item('dislike', 'ban', lang('MusicDislike')),
    fileMenu.length && item('file', 'copy', lang('MusicFileMenu'), { submenu: fileMenu }),
  ].filter((action): action is MusicMenuAction => Boolean(action));
  const facts = [track.artist, track.album || formatTrackTime(track.durationSecs), note].filter(Boolean).join(' · ');

  if (isPicking) return <MusicPlaylistPicker tracks={[track]} onClose={onClose} />;

  return (
    <MusicMenu
      title={track.title}
      facts={facts}
      cover={(
        <MusicCover
          coverId={track.coverId}
          toneId={track.albumId || track.id}
          size={40}
          className={music.trackCover}
        />
      )}
      quick={quick}
      actions={actions}
      anchor={anchor}
      onPick={handlePick}
      onClose={onClose}
    />
  );
};

export default memo(MusicTrackMenu);
