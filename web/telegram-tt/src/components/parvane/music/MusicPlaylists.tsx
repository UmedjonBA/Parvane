import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicMenuAction } from './MusicMenu';

import buildClassName from '../../../util/buildClassName';
import { coverTone, splitListTime } from './musicFormat';
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
import MusicSendDialog from './MusicSendDialog';
import MusicTrackRow from './MusicTrackRow';
import MusicMakeShared from './shared/MusicMakeShared';

import sheets from '../cloud/CloudSheets.module.scss';
import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';
import page from './MusicPage.module.scss';

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
const COVER_PHONE = 220;
const COVER_DESK = 150;
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
    } else if (key === 'chat') {
      openSend();
    } else if (key === 'shuffle') {
      handleShuffle();
    }
  });
  // ♡+ (доска `MusicPlaylist-02`): все треки плейлиста — в «Любимое»; уже все там — убрать
  const isAllStarred = playable.length > 0 && playable.every((track) => track.isStarred);
  const handleStarAll = useLastCallback(() => {
    playable.filter((track) => track.isStarred === isAllStarred).forEach(handleStar);
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
    { key: 'shuffle', title: lang('MusicShuffleOn'), isDisabled: !playable.length },
    { key: 'chat', title: lang('MusicSendToChat'), isDisabled: !rows.length },
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

  return (
    <div className={buildClassName(page.root, isPhone && page.rootPhone)} data-music-playlist={playlist.id}>
      <div className={page.hero} style={`--hero-tone: ${coverTone(playlist.id)}`}>
        <button type="button" className={page.back} aria-label={lang('Back')} data-music-back onClick={goBackMusic}>
          <ParvaneIcon name="left" />
        </button>
        <MusicCover
          toneId={playlist.id}
          size={isPhone ? COVER_PHONE : COVER_DESK}
          glyph="list"
          isLarge
          className={page.heroCover}
        />
        <div className={page.heroText}>
          {!isPhone && <div className={page.kicker}>{lang('MusicPlaylistKicker')}</div>}
          <h1 className={page.title} data-music-title>{playlist.name}</h1>
          <div className={page.owner}>{lang('MusicPlaylistMineTitle')}</div>
          <div className={page.metaPlain}>{subtitle}</div>
        </div>
      </div>
      <div className={page.actions}>
        {!isPhone && renderPlay()}
        <button
          type="button"
          className={buildClassName(page.action, isAllStarred && page.actionOn)}
          aria-label={lang(isAllStarred ? 'MusicUnstar' : 'MusicStar')}
          aria-pressed={isAllStarred}
          disabled={!playable.length}
          data-music-star-playlist
          onClick={handleStarAll}
        >
          <ParvaneIcon name={isAllStarred ? 'heart' : 'heartPlus'} />
        </button>
        <MusicOfflineCircle tracks={playable} holder={holder} />
        <button
          type="button"
          className={page.action}
          aria-label={lang('MusicMore')}
          aria-haspopup="menu"
          data-music-playlist-menu
          onClick={handleMenu}
        >
          <ParvaneIcon name="dotsH" />
        </button>
        {isPhone && <span className={page.actionsGap} />}
        {isPhone && renderPlay()}
      </div>
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
              rank={index + 1}
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

  function renderPlay() {
    return (
      <button
        type="button"
        className={page.play}
        aria-label={lang('MusicPlay')}
        disabled={!playable.length}
        data-music-play-all
        onClick={handlePlayAll}
      >
        <ParvaneIcon name="play" />
      </button>
    );
  }
};

export default memo(MusicPlaylists);
