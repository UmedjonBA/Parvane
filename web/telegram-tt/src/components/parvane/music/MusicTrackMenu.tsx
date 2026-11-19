import { memo } from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import type { CloudMenuAction, CloudMenuAnchor } from '../cloud/CloudMenu';

import { formatTrackTime } from './musicFormat';
import { goToMusic } from './musicGoTo';
import {
  getOfflineState, isTrackSaving, removeOffline, saveTracksOffline,
} from './musicOffline';
import { addToQueue } from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import CloudMenu from '../cloud/CloudMenu';

import sheets from '../cloud/CloudSheets.module.scss';

type MenuKey = 'next' | 'queue' | 'star' | 'playlist' | 'chat' | 'offline' | 'artist' | 'album' | 'delete';

type OwnProps = {
  track: MusicTrack;
  // Компьютер: меню у этой точки; без неё — шторка снизу (телефон)
  anchor?: CloudMenuAnchor;
  // Приписка «добавил(а) …» — в строке сведений
  note?: string;
  canQueue?: boolean;
  canSaveOffline?: boolean;
  onStar?: (track: MusicTrack) => void;
  onAddToPlaylist?: (track: MusicTrack) => void;
  onSendToChat?: (track: MusicTrack) => void;
  onDelete?: (track: MusicTrack) => void;
  onClose: NoneToVoidFunction;
};

// Меню трека (доски `XpMusic`, `ZdMusicX`): очередь, любимое, плейлист, чат, трек на устройстве, переходы,
// удаление из библиотеки сервера. Пункт есть, только если его действие доступно там, где стоит строка
const MusicTrackMenu = ({
  track, anchor, note, canQueue, canSaveOffline, onStar, onAddToPlaylist, onSendToChat, onDelete, onClose,
}: OwnProps) => {
  const lang = useLang();
  const offline = useDerivedState(getOfflineState);
  const isSaved = offline.entries.some((entry) => entry.track.id === track.id);
  const isSaving = !isSaved && offline.pending > 0 && isTrackSaving(track.id);

  const handlePick = useLastCallback((key: string) => {
    onClose();
    const run: Record<MenuKey, NoneToVoidFunction> = {
      next: () => addToQueue([track], true),
      queue: () => addToQueue([track], false),
      star: () => onStar?.(track),
      playlist: () => onAddToPlaylist?.(track),
      chat: () => onSendToChat?.(track),
      offline: () => (isSaved ? void removeOffline([track.id]) : saveTracksOffline([track])),
      artist: () => goToMusic({ kind: 'artist', id: track.artistId }),
      album: () => goToMusic({ kind: 'album', id: track.albumId }),
      delete: () => onDelete?.(track),
    };
    run[key as MenuKey]();
  });

  const item = (
    key: MenuKey, icon: ParvaneIconName, title: string, extra?: Partial<CloudMenuAction>,
  ): CloudMenuAction => ({
    key, title, glyph: <ParvaneIcon name={icon} className={sheets.menuIcon} />, ...extra,
  });
  const offlineKey = isSaved ? 'MusicOfflineRemoveTrack' : isSaving ? 'MusicOfflineSaving' : 'MusicOfflineSaveTrack';
  const actions = [
    canQueue && item('next', 'next', lang('MusicPlayNext')),
    canQueue && item('queue', 'list', lang('MusicAddToQueue')),
    onStar && item('star', 'heart', lang(track.isStarred ? 'MusicUnstar' : 'MusicStar')),
    onAddToPlaylist && item('playlist', 'plus', lang('MusicAddToPlaylist')),
    onSendToChat && item('chat', 'chat', lang('MusicSendToChat')),
    canSaveOffline && item('offline', isSaved ? 'downloaded' : 'download', lang(offlineKey), { isDisabled: isSaving }),
    track.artistId && item('artist', 'user', lang('MusicGoToArtist')),
    track.albumId && item('album', 'disc', lang('MusicGoToAlbum')),
    onDelete && item('delete', 'close', lang('MusicDeleteFromServer'), { isDanger: true }),
  ].filter((action): action is CloudMenuAction => Boolean(action));
  const facts = [track.artist, formatTrackTime(track.durationSecs), note].filter(Boolean).join(' · ');

  return (
    <CloudMenu
      isOpen
      title={track.title}
      facts={facts}
      actions={actions}
      anchor={anchor}
      onPick={handlePick}
      onClose={onClose}
    />
  );
};

export default memo(MusicTrackMenu);
