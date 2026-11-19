import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { MusicPlaylist, MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { splitListTime } from './musicFormat';
import { saveTracksOffline } from './musicOffline';
import { playTracks } from './musicPlayer';
import {
  actOnPlaylists, getPlaylists, getPlaylistsStatus, loadPlaylistTracks, refreshPlaylists,
} from './musicPlaylists';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  // Открытый плейлист; не задан — список плейлистов
  playlistId?: string;
  currentTrackId?: string;
  isPlaying?: boolean;
  onOpen: (playlistId?: string) => void;
};

const STATUS_KEYS = {
  'needs-linking': 'MusicPlaylistsNeedLinking',
  'no-key': 'MusicPlaylistsNoKey',
  offline: 'MusicPlaylistsOffline',
} as const;

// Parvane (spec 039, этап C): плейлисты пользователя — список и страница плейлиста. Плейлисты лежат в личном
// контейнере (сервер видит шифртекст) и одинаковы на всех устройствах; порядок и правки считает общая
// библиотека на устройстве (MUSIC-2)
const MusicPlaylists = ({
  playlistId, currentTrackId, isPlaying, onOpen,
}: OwnProps) => {
  const lang = useLang();
  const playlists = useDerivedState(getPlaylists);
  const status = useDerivedState(getPlaylistsStatus);
  const [newName, setNewName] = useState('');
  const [libraryTracks, setLibraryTracks] = useState<Map<string, MusicTrack>>();
  const [isDeleteAsked, askDelete, cancelDelete] = useFlag();
  const playlist = playlistId ? playlists.find((item) => item.id === playlistId) : undefined;
  const trackIdsKey = playlist?.items.map((item) => item.trackId).join('\n');

  useEffect(() => {
    void refreshPlaylists();
  }, []);

  const handleRetry = useLastCallback(() => {
    void refreshPlaylists();
  });

  // Сведения о треках (обложка, отметка «любимое») — с сервера; подписи из плейлиста видны сразу
  useEffect(() => {
    if (!trackIdsKey) return;
    let isStale = false;
    void loadPlaylistTracks(trackIdsKey.split('\n')).then((tracks) => {
      if (!isStale) setLibraryTracks(tracks);
    }).catch(() => undefined);
    return () => {
      isStale = true;
    };
  }, [trackIdsKey]);

  useEffect(cancelDelete, [playlistId, cancelDelete]);

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

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.currentTarget.value);
  });

  const handleCreate = useLastCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    const created = await actOnPlaylists({ action: 'create', name });
    if (created?.id) onOpen(created.id);
  });

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onOpen(e.currentTarget.dataset.playlist);
  });

  const handleBack = useLastCallback(() => onOpen(undefined));

  const handleRename = useLastCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const name = e.currentTarget.value.trim();
    if (!name || name === playlist!.name) {
      e.currentTarget.value = playlist!.name;
      return;
    }
    void actOnPlaylists({ action: 'rename', playlistId: playlist!.id, name });
  });

  const handleRenameKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur();
  });

  const handleDelete = useLastCallback(async () => {
    await actOnPlaylists({ action: 'delete', playlistId: playlist!.id });
    onOpen(undefined);
  });

  const handlePlay = useLastCallback((index: number) => {
    const playable = rows.filter((row) => !row.isMissing);
    const start = playable.indexOf(rows[index]);
    if (start >= 0) playTracks(playable.map((row) => row.track), start);
  });

  const handlePlayAll = useLastCallback(() => {
    const first = rows.findIndex((row) => !row.isMissing);
    if (first >= 0) handlePlay(first);
  });

  const handleSaveOffline = useLastCallback(() => {
    saveTracksOffline(rows.filter((row) => !row.isMissing).map((row) => row.track));
  });

  const handleRemove = useLastCallback((index: number) => {
    void actOnPlaylists({ action: 'remove', itemId: rows[index].itemId });
  });

  const handleMove = useLastCallback((index: number, toIndex: number) => {
    void actOnPlaylists({ action: 'move', itemId: rows[index].itemId, toIndex });
  });

  function renderList(items: MusicPlaylist[]) {
    return (
      <>
        <form className={styles.playlistForm} onSubmit={handleCreate}>
          <input
            className={buildClassName(kit.input, kit.grow)}
            value={newName}
            maxLength={120}
            placeholder={lang('MusicPlaylistNewPlaceholder')}
            aria-label={lang('MusicPlaylistNewPlaceholder')}
            onChange={handleNameChange}
          />
          <button type="submit" className={buildClassName(kit.btn, kit.btnAcc)} disabled={!newName.trim()}>
            {lang('MusicPlaylistCreate')}
          </button>
        </form>
        {!items.length && <PvEmpty text={lang('MusicPlaylistsEmpty')} data-music-empty />}
        {Boolean(items.length) && (
          <ul className={styles.tracks} data-music-playlists>
            {items.map((item) => {
              const time = splitListTime(item.durationSecs);
              return (
                <li key={item.id} className={styles.track}>
                  <button type="button" className={styles.trackMain} data-playlist={item.id} onClick={handleOpen}>
                    <span className={styles.trackText}>
                      <span className={styles.trackTitle}>{item.name}</span>
                      <span className={buildClassName(kit.muted, kit.small)}>
                        {lang('MusicTracksCount', { count: item.count }, { pluralValue: item.count })}
                      </span>
                    </span>
                    <span className={buildClassName(kit.mono, kit.muted, kit.small)}>
                      {lang('MusicListTime', { hours: time.hours, minutes: time.minutes })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  function renderPlaylist(opened: MusicPlaylist) {
    const time = splitListTime(opened.durationSecs);
    return (
      <div className={styles.playlist} data-music-playlist={opened.id}>
        <div className={styles.listHead}>
          <button type="button" className={kit.btn} onClick={handleBack}>{lang('MusicPlaylistsAll')}</button>
          <input
            key={opened.id}
            className={buildClassName(kit.input, kit.grow, styles.playlistName)}
            defaultValue={opened.name}
            maxLength={120}
            aria-label={lang('MusicPlaylistName')}
            onBlur={handleRename}
            onKeyDown={handleRenameKey}
          />
          <span className={buildClassName(kit.muted, kit.small)}>
            {lang('MusicListTime', { hours: time.hours, minutes: time.minutes })}
          </span>
          {Boolean(rows.length) && (
            <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handlePlayAll}>
              {lang('MusicPlayAll')}
            </button>
          )}
          {Boolean(rows.length) && (
            <button type="button" className={kit.btn} data-music-save-offline onClick={handleSaveOffline}>
              {lang('MusicOfflineSave')}
            </button>
          )}
          <button
            type="button"
            className={buildClassName(kit.btn, isDeleteAsked && kit.btnDanger)}
            data-playlist-delete={isDeleteAsked ? 'confirm' : 'ask'}
            onClick={isDeleteAsked ? handleDelete : askDelete}
          >
            {lang(isDeleteAsked ? 'MusicPlaylistDeleteConfirm' : 'MusicPlaylistDelete')}
          </button>
        </div>
        {!rows.length && <PvEmpty text={lang('MusicPlaylistEmpty')} data-music-empty />}
        {Boolean(rows.length) && (
          <ul className={styles.tracks} data-music-tracks>
            {rows.map((row, index) => (
              <MusicTrackRow
                key={row.itemId}
                track={row.track}
                index={index}
                isCurrent={row.track.id === currentTrackId}
                isPlaying={isPlaying}
                isMissing={row.isMissing}
                note={row.isMissing ? lang('MusicTrackMissing') : undefined}
                canRemove
                removeLabel={lang('MusicPlaylistRemove', { name: row.track.title })}
                lastIndex={rows.length - 1}
                onPlay={handlePlay}
                onRemove={handleRemove}
                onMove={handleMove}
              />
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (status !== 'ready' && status !== 'loading') {
    return <div className={styles.error} role="status" data-playlists-status={status}>{lang(STATUS_KEYS[status])}</div>;
  }
  if (status === 'loading' && !playlists.length) {
    return <PvSkeleton data-playlists-status="loading" onRetry={handleRetry} />;
  }
  return playlist ? renderPlaylist(playlist) : renderList(playlists);
};

export default memo(MusicPlaylists);
