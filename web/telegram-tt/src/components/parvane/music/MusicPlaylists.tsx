import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicMenuAction } from './MusicMenu';

import buildClassName from '../../../util/buildClassName';
import { splitListTime } from './musicFormat';
import { getOfflineHolds, getOfflineState, removeOfflineGroup, saveTracksOffline } from './musicOffline';
import {
  getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import {
  actOnPlaylists, getPlaylists, getPlaylistsStatus, loadPlaylistTracks, refreshPlaylists,
} from './musicPlaylists';
import { goBackMusic, openMusicView } from './musicView';
import useDragReorder from './useDragReorder';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvSheet from '../notes/PvSheet';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicMenu from './MusicMenu';
import MusicOfflineCircle from './MusicOfflineCircle';
import MusicPlayButtons from './MusicPlayButtons';
import MusicSectionHead from './MusicSectionHead';
import MusicSendDialog from './MusicSendDialog';
import MusicTrackRow from './MusicTrackRow';
import MusicMakeShared from './shared/MusicMakeShared';

import sheets from '../cloud/CloudSheets.module.scss';
import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  playlistId: string;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

const STATUS_KEYS = {
  'needs-linking': 'MusicPlaylistsNeedLinking',
  'no-key': 'MusicPlaylistsNoKey',
  offline: 'MusicPlaylistsOffline',
} as const;
const COVER_PHONE = 96;
const COVER_DESK = 72;
const NAME_MAX = 120;

// Parvane (spec 039 этап C, 041; доски `MusicPlaylist`, `DeskMusicMore`): страница плейлиста — обложка тоном,
// «Мой плейлист», «N треков · время · загружен для офлайна», «Играть / Вперемешку», «Отправить в чат», меню «Ещё»
// (переименовать, на устройство, удалить), треки с номерами. Плейлисты лежат в личном контейнере (сервер видит
// шифртекст); порядок и правки считает общая библиотека на устройстве (MUSIC-2). Порядок — перетаскиванием за
// ручку на компьютере, «Выше / Ниже» в меню трека на телефоне
const MusicPlaylists = ({ playlistId, isPhone, onSendToChat }: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const status = useDerivedState(getPlaylistsStatus);
  const player = useDerivedState(getMusicPlayer);
  // Перерисовка при смене «Загруженного»: отметка плейлиста читается из `getOfflineHolds`
  useDerivedState(getOfflineState);
  const currentId = getCurrentTrack(player)?.id;
  const [libraryTracks, setLibraryTracks] = useState<Map<string, MusicTrack>>();
  const [isSendOpen, openSend, closeSend] = useFlag();
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | true>();
  const [isRenameOpen, openRename, closeRename] = useFlag();
  const [isDeleteOpen, openDelete, closeDelete] = useFlag();
  const [isMakeSharedOpen, openMakeShared, closeMakeShared] = useFlag();
  const [newName, setNewName] = useState('');
  const playlist = playlists.find((item) => item.id === playlistId);
  const trackIdsKey = playlist?.items.map((item) => item.trackId).join('\n');

  useEffect(() => {
    void refreshPlaylists();
  }, []);

  // Сведения о треках (обложка, альбом, отметка «любимое») — с сервера; подписи из плейлиста видны сразу
  useEffect(() => {
    if (!trackIdsKey) return undefined;
    let isStale = false;
    void loadPlaylistTracks(trackIdsKey.split('\n')).then((tracks) => {
      if (!isStale) setLibraryTracks(tracks);
    }).catch(() => undefined);
    return () => {
      isStale = true;
    };
  }, [trackIdsKey]);

  const rows = useMemo(() => (playlist?.items || []).map((item) => {
    const known = libraryTracks?.get(item.trackId);
    const track: MusicTrack = known || {
      id: item.trackId,
      title: item.title,
      artist: item.artist,
      album: '',
      albumId: '',
      artistId: '',
      durationSecs: item.durationSecs,
      coverId: '',
      trackNo: 0,
      year: 0,
      isStarred: false,
    };
    // Трека нет в ответе сервера — его убрали из библиотеки: строка остаётся, играть нечего
    return { itemId: item.id, track, isMissing: Boolean(libraryTracks) && !known };
  }), [playlist, libraryTracks]);
  const playable = useMemo(() => rows.filter((row) => !row.isMissing).map((row) => row.track), [rows]);
  const source = { kind: 'playlist' as const, name: playlist?.name };

  const handlePlay = useLastCallback((index: number) => {
    const start = playable.indexOf(rows[index].track);
    if (start >= 0) playTracks(playable, start, { source });
  });
  const handlePlayAll = useLastCallback(() => playTracks(playable, 0, { source }));
  const handleShuffle = useLastCallback(() => playTracks(playable, 0, { isShuffled: true, source }));

  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    setLibraryTracks((previous) => {
      if (!previous?.has(track.id)) return previous;
      const next = new Map(previous);
      next.set(track.id, { ...track, isStarred });
      return next;
    });
    void setTrackStarred(track, isStarred);
  });

  // Место строки считает движок (MUSIC-2): перестановка — правка одной записи
  const handleMove = useLastCallback((index: number, toIndex: number) => {
    void actOnPlaylists({ action: 'move', itemId: rows[index].itemId, toIndex });
  });
  const { handlers: drag, getRowState } = useDragReorder(rows.length, handleMove);

  const handleMenu = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setMenuAnchor(isPhone ? true : { x: box.left, y: box.bottom });
  });
  const handleCloseMenu = useLastCallback(() => setMenuAnchor(undefined));

  const holder = { kind: 'playlist' as const, id: playlistId };
  const isHeld = Boolean(getOfflineHolds().playlists[playlistId]);

  const handlePick = useLastCallback((key: string) => {
    setMenuAnchor(undefined);
    if (key === 'rename') {
      setNewName(playlist!.name);
      openRename();
    } else if (key === 'offline') {
      if (isHeld) void removeOfflineGroup(holder, playable.map((track) => track.id));
      else saveTracksOffline(playable, holder);
    } else if (key === 'delete') {
      openDelete();
    } else if (key === 'share') {
      openMakeShared();
    }
  });

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.currentTarget.value);
  });

  const handleRename = useLastCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    const name = newName.trim();
    closeRename();
    if (name && name !== playlist!.name) void actOnPlaylists({ action: 'rename', playlistId, name });
  });

  const handleDelete = useLastCallback(async () => {
    closeDelete();
    await actOnPlaylists({ action: 'delete', playlistId });
    if (isPhone) goBackMusic();
    else openMusicView({ kind: 'home' }, true);
  });

  if (status !== 'ready' && status !== 'loading') {
    return <div className={styles.error} role="status" data-playlists-status={status}>{lang(STATUS_KEYS[status])}</div>;
  }
  if (!playlist) return <PvSkeleton data-playlists-status={status} />;

  const time = splitListTime(playlist.durationSecs);
  const subtitle = [
    lang('MusicTracksCount', { count: playlist.count }, { pluralValue: playlist.count }),
    lang('MusicListTime', { hours: time.hours, minutes: time.minutes }),
    isHeld && !isPhone && lang('MusicPlaylistOfflineMark'),
  ].filter(Boolean).join(' · ');
  const menuActions: MusicMenuAction[] = [
    { key: 'rename', title: lang('MusicPlaylistRename') },
    {
      key: 'offline',
      title: lang(isHeld ? 'MusicOfflineRemovePlaylist' : 'MusicOfflineSavePlaylist'),
      isDisabled: !playable.length,
    },
    // Общий плейлист (MUSIC-3, исполнитель «musicshared»): «Кто видит» и перенос треков на сервер
    { key: 'share', title: lang('MusicMakeShared') },
    {
      key: 'delete', title: lang('MusicPlaylistDelete'), isDanger: true, hasDivider: !isPhone,
    },
  ];
  const moreButton = (
    <button
      type="button"
      className={kit.ib}
      aria-label={lang('MusicMore')}
      aria-haspopup="menu"
      data-music-playlist-menu
      onClick={handleMenu}
    >
      <ParvaneIcon name="more" className={styles.moreIcon} />
    </button>
  );
  const sendButton = (
    <button
      type="button"
      className={kit.ib}
      aria-label={lang('MusicSendToChat')}
      data-music-playlist-to-chat
      disabled={!rows.length}
      onClick={openSend}
    >
      <ParvaneIcon name="send" />
    </button>
  );

  return (
    <div className={styles.view} data-music-playlist={playlist.id}>
      <MusicSectionHead
        title={playlist.name}
        barTitle={lang('MusicPlaylistKicker')}
        kicker={isPhone ? undefined : lang('MusicPlaylistMineTitle')}
        cover={(
          <MusicCover
            toneId={playlist.id}
            size={isPhone ? COVER_PHONE : COVER_DESK}
            glyph="list"
            className={styles.heroCover}
          />
        )}
        subtitle={isPhone ? (
          <>
            <div>{lang('MusicPlaylistMineTitle')}</div>
            <div>{subtitle}</div>
          </>
        ) : subtitle}
        isPhone={isPhone}
        barActions={(
          <>
            {sendButton}
            {moreButton}
          </>
        )}
        actions={(
          <>
            <MusicPlayButtons isDisabled={!playable.length} onPlay={handlePlayAll} onShuffle={handleShuffle} />
            {isPhone && <MusicOfflineCircle tracks={playable} holder={holder} />}
            {!isPhone && (
              <button
                type="button"
                className={kit.btn}
                data-music-playlist-to-chat
                disabled={!rows.length}
                onClick={openSend}
              >
                {lang('MusicSendToChat')}
              </button>
            )}
            {!isPhone && (
              <button type="button" className={kit.btn} data-music-make-shared onClick={openMakeShared}>
                {lang('MusicMakeShared')}
              </button>
            )}
            {!isPhone && moreButton}
          </>
        )}
        onBack={goBackMusic}
      />
      {!rows.length && <PvEmpty text={lang('MusicPlaylistEmpty')} data-music-empty />}
      {Boolean(rows.length) && !isPhone && (
        <div className={buildClassName(styles.tableHead, kit.muted, kit.small)} aria-hidden>
          <span className={styles.trackNo}>#</span>
          <span className={kit.grow}>{lang('MusicColumnTitle')}</span>
          <span className={styles.trackCell}>{lang('MusicColumnArtist')}</span>
          <span className={styles.trackCell}>{lang('MusicColumnAlbum')}</span>
          <span>{lang('MusicColumnTime')}</span>
        </div>
      )}
      {Boolean(rows.length) && (
        <ul className={styles.tracks} data-music-tracks>
          {rows.map((row, index) => (
            <MusicTrackRow
              key={row.itemId}
              track={row.track}
              index={index}
              number={index + 1}
              columns={isPhone ? undefined : ['artist', 'album']}
              isCurrent={row.track.id === currentId}
              isPlaying={player.isPlaying}
              isMissing={row.isMissing}
              note={row.isMissing ? lang('MusicTrackMissing') : undefined}
              dragLabel={isPhone ? undefined : lang('MusicPlaylistDrag', { name: row.track.title })}
              dragState={isPhone ? undefined : getRowState(index)}
              drag={isPhone ? undefined : drag}
              extra={{
                removeLabel: lang('MusicPlaylistRemoveItem'),
                onRemove: () => void actOnPlaylists({ action: 'remove', itemId: row.itemId }),
                onMoveUp: isPhone && index > 0 ? () => handleMove(index, index - 1) : undefined,
                onMoveDown: isPhone && index < rows.length - 1 ? () => handleMove(index, index + 1) : undefined,
              }}
              canQueue
              canSaveOffline
              onPlay={handlePlay}
              onStar={handleStar}
              onSendToChat={onSendToChat}
            />
          ))}
        </ul>
      )}
      <MusicMakeShared isOpen={isMakeSharedOpen} playlist={playlist} onClose={closeMakeShared} />
      {menuAnchor && (
        <MusicMenu
          title={playlist.name}
          actions={menuActions}
          anchor={menuAnchor === true ? undefined : menuAnchor}
          onPick={handlePick}
          onClose={handleCloseMenu}
        />
      )}
      <PvSheet isOpen={isRenameOpen} title={lang('MusicPlaylistRename')} onClose={closeRename}>
        <form className={sheets.form} onSubmit={handleRename}>
          <input
            className={kit.input}
            value={newName}
            maxLength={NAME_MAX}
            aria-label={lang('MusicPlaylistName')}
            data-music-playlist-name
            onChange={handleNameChange}
          />
          <div className={kit.sheetButtons}>
            <button type="button" className={kit.btn} onClick={closeRename}>{lang('Cancel')}</button>
            <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)} disabled={!newName.trim()}>
              {lang('Save')}
            </button>
          </div>
        </form>
      </PvSheet>
      <PvSheet
        isOpen={isDeleteOpen}
        title={lang('MusicPlaylistDeleteTitle', { name: playlist.name })}
        onClose={closeDelete}
      >
        <p className={kit.muted}>{lang('MusicPlaylistDeleteText')}</p>
        <div className={kit.sheetButtons}>
          <button type="button" className={kit.btn} onClick={closeDelete}>{lang('Cancel')}</button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnDanger)}
            data-playlist-delete="confirm"
            onClick={handleDelete}
          >
            {lang('MusicPlaylistDelete')}
          </button>
        </div>
      </PvSheet>
      <MusicSendDialog playlist={isSendOpen ? playlist : undefined} onClose={closeSend} />
    </div>
  );
};

export default memo(MusicPlaylists);
