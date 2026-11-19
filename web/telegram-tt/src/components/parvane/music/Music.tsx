import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type {
  MusicAddedTrack, MusicAlbum, MusicArtist, MusicTrack,
} from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { getParvaneSection } from '../../../util/parvaneSection';
import { splitBytes, splitListTime } from './musicFormat';
import { saveTracksOffline } from './musicOffline';
import {
  addToQueue, callMusic, getCurrentTrack, getMusicInfo, getMusicPlayer, getMusicRecent, loadMusicInfo, playTracks,
  restoreMusicQueue, setTrackStarred,
} from './musicPlayer';
import { openMusicPlayer } from './musicPlayerView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useBrowserOnline from '../../../hooks/window/useBrowserOnline';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvLoading from '../notes/PvLoading';
import PvOfflineBar from '../notes/PvOfflineBar';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicFetch from './MusicFetch';
import MusicOffline from './MusicOffline';
import MusicPlaylistPicker from './MusicPlaylistPicker';
import MusicPlaylists from './MusicPlaylists';
import MusicQueue from './MusicQueue';
import MusicSendDialog from './MusicSendDialog';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type View =
  | { kind: 'home' | 'starred' | 'artists' | 'albums' | 'added' | 'offline' | 'queue' }
  // Плейлисты пользователя: список либо открытый плейлист
  | { kind: 'playlists'; id?: string }
  | { kind: 'album'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'search'; query: string };

type Content = {
  tracks?: MusicTrack[];
  albums?: MusicAlbum[];
  artists?: MusicArtist[];
  // Добавленное: «Новое на сервере» (с тем, кто добавил) и «Загруженное» (своё)
  added?: MusicAddedTrack[];
  title?: string;
  subtitle?: string;
  isFailed?: boolean;
};

const NAV = [
  { kind: 'home', icon: 'home', titleKey: 'MusicHome' },
  { kind: 'starred', icon: 'heart', titleKey: 'MusicStarred' },
  { kind: 'artists', icon: 'users', titleKey: 'MusicArtists' },
  { kind: 'albums', icon: 'disc', titleKey: 'MusicAlbums' },
] as const;
const SEARCH_DELAY_MS = 300;
const EMPTY_KEYS = { starred: 'MusicStarredEmpty', added: 'MusicAddedEmpty' } as const;

/** Содержимое вида с сервера. Библиотека целиком — поиск с пустой строкой. */
async function fetchContent(view: View, isFetchEnabled: boolean): Promise<Content> {
  switch (view.kind) {
    case 'home': {
      // С подключённым скачиванием «Новое на сервере» — добавленные треки с тем, кто добавил
      const [albums, added] = await Promise.all([
        callMusic('parvaneMusicRecent'),
        isFetchEnabled ? callMusic('parvaneMusicAdded', { isMine: false }).catch(() => []) : [],
      ]);
      return { albums, added };
    }
    case 'added':
      return { added: await callMusic('parvaneMusicAdded', { isMine: true }) };
    case 'starred':
      return { tracks: (await callMusic('parvaneMusicStarred')).tracks };
    case 'artists':
      return { artists: (await callMusic('parvaneMusicSearch', { query: '' })).artists };
    case 'albums':
      return { albums: (await callMusic('parvaneMusicSearch', { query: '' })).albums };
    case 'album': {
      const { album, tracks } = await callMusic('parvaneMusicAlbum', { albumId: view.id });
      return { tracks, title: album?.title, subtitle: album?.artist };
    }
    case 'artist': {
      const { artist, albums } = await callMusic('parvaneMusicArtist', { artistId: view.id });
      return { albums, title: artist?.name };
    }
    case 'search':
      return callMusic('parvaneMusicSearch', { query: view.query });
    default:
      return {};
  }
}

// Parvane (spec 039, 041): модуль «Музыка» — общая библиотека сервера. Слева разделы, в середине список,
// справа плеер с очередью (на телефоне плеер — отдельный вид). Рекомендации («Микс дня») появятся позже:
// на главной стоит заглушка. Плеер один на приложение (`musicPlayer.ts`)
const Music = () => {
  const lang = useLang();
  const section = useDerivedState(getParvaneSection);
  const info = useDerivedState(getMusicInfo);
  const player = useDerivedState(getMusicPlayer);
  const recent = useDerivedState(getMusicRecent);
  const [view, setView] = useState<View>({ kind: 'home' });
  // Содержимое помнит, для какого вида оно загружено: список прежнего вида под новым заголовком не показывается
  const [loaded, setLoaded] = useState<{ view: View; content: Content }>();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>();
  // Трек, для которого выбирают плейлист
  const [pickerTrack, setPickerTrack] = useState<MusicTrack>();
  // Трек, который отправляют в чат
  const [sentTrack, setSentTrack] = useState<MusicTrack>();
  const loadIdRef = useRef(0);
  const current = getCurrentTrack(player);
  const content = loaded?.view === view ? loaded.content : undefined;
  const isShown = section === 'music';
  const isOnline = useBrowserOnline();

  useEffect(() => {
    if (!isShown || info) return;
    void loadMusicInfo().then((fresh) => {
      if (fresh.isEnabled) void restoreMusicQueue();
    });
  }, [isShown, info]);

  const load = useLastCallback(async (next: View) => {
    const id = ++loadIdRef.current;
    const fetched = await fetchContent(next, Boolean(getMusicInfo()?.isFetchEnabled))
      .catch((): Content => ({ isFailed: true }));
    // Пока шёл запрос, открыли другой вид
    if (id === loadIdRef.current) setLoaded({ view: next, content: fetched });
  });

  const isEnabled = info?.isEnabled;
  const isPlaylistsShown = isShown && view.kind === 'playlists';
  useEffect(() => {
    if (isShown && isEnabled && view.kind !== 'playlists' && view.kind !== 'offline') void load(view);
  }, [isShown, isEnabled, view, load]);

  // Пока плейлисты на экране, их контейнер сверяется с сервером часто
  useEffect(() => {
    if (!isPlaylistsShown) return undefined;
    void callMusic('parvaneMusicPlaylistsSetActive', { isActive: true });
    return () => {
      void callMusic('parvaneMusicPlaylistsSetActive', { isActive: false });
    };
  }, [isPlaylistsShown]);

  // Поиск идёт с задержкой после набора; пустая строка возвращает главную
  useEffect(() => {
    const text = query.trim();
    const timer = window.setTimeout(() => {
      setView((previous) => {
        if (text) return { kind: 'search', query: text };
        return previous.kind === 'search' ? { kind: 'home' } : previous;
      });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const handleFocusSearch = useLastCallback(() => searchRef.current?.focus());

  const handleQueryChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handleNav = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.currentTarget.dataset.view === 'queue' && getCurrentTrack()) {
      openMusicPlayer();
      return;
    }
    setQuery('');
    setView({ kind: e.currentTarget.dataset.view as 'home' });
  });

  const handleOpenAlbum = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setQuery('');
    setView({ kind: 'album', id: e.currentTarget.dataset.id! });
  });

  const handleOpenArtist = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setQuery('');
    setView({ kind: 'artist', id: e.currentTarget.dataset.id! });
  });

  const handlePlayFrom = useLastCallback((index: number) => {
    if (content?.tracks) playTracks(content.tracks, index);
  });

  const handlePlayRecent = useLastCallback((index: number) => playTracks(recent, index));

  const handlePlayAdded = useLastCallback((index: number) => {
    const tracks = (content?.added || []).map((item) => item.track).filter((track) => track.id);
    playTracks(tracks, index);
  });

  // Скачанный трек из блока «Найти в сети»: сведения берутся с сервера и трек играет
  const handlePlayLibraryTrack = useLastCallback(async (trackId: string) => {
    const tracks = await callMusic('parvaneMusicTracks', { trackIds: [trackId] }).catch(() => []);
    const found = tracks.filter(Boolean);
    if (found.length) playTracks(found, 0);
  });

  const handleDeleteAdded = useLastCallback(async (track: MusicTrack) => {
    await callMusic('parvaneMusicAddedDelete', { trackId: track.id }).catch(() => undefined);
    void loadMusicInfo();
    void load(view);
  });
  const handlePlayAll = useLastCallback(() => handlePlayFrom(0));
  const handleRetry = useLastCallback(() => {
    void loadMusicInfo();
    if (view.kind !== 'playlists' && view.kind !== 'offline') void load(view);
  });
  const handleSaveOffline = useLastCallback(() => {
    if (content?.tracks) saveTracksOffline(content.tracks);
  });
  const handleOpenPlaylist = useLastCallback((id?: string) => setView({ kind: 'playlists', id }));
  const handleClosePicker = useLastCallback(() => setPickerTrack(undefined));
  const handleCloseSend = useLastCallback(() => setSentTrack(undefined));
  const handleAddNext = useLastCallback((track: MusicTrack) => addToQueue([track], true));

  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    // Отметка видна сразу и в открытом списке, и в очереди
    setLoaded((previous) => (previous?.content.tracks ? {
      view: previous.view,
      content: {
        ...previous.content,
        tracks: previous.content.tracks.map((item) => (item.id === track.id ? { ...item, isStarred } : item)),
      },
    } : previous));
    void setTrackStarred(track, isStarred);
  });

  function renderTracks(tracks: MusicTrack[], onPlay: (index: number) => void) {
    return (
      <ul className={styles.tracks} data-music-tracks>
        {tracks.map((track, index) => (
          <MusicTrackRow
            key={track.id}
            track={track}
            index={index}
            isCurrent={track.id === current?.id}
            isPlaying={player.isPlaying}
            canSaveOffline
            onPlay={onPlay}
            onStar={handleStar}
            onAddNext={handleAddNext}
            onAddToPlaylist={setPickerTrack}
            onSendToChat={setSentTrack}
          />
        ))}
      </ul>
    );
  }

  function renderSize(bytes: number) {
    const size = splitBytes(bytes);
    const digits = size.isGigabytes ? 1 : 0;
    const value = new Intl.NumberFormat(lang.code, { maximumFractionDigits: digits }).format(size.value);
    return lang(size.isGigabytes ? 'MusicSizeGb' : 'MusicSizeMb', { value });
  }

  function renderAdded(added: MusicAddedTrack[], isMine: boolean) {
    return (
      <ul className={styles.tracks} data-music-added={isMine ? 'mine' : 'all'}>
        {added.map((item, index) => (
          <MusicTrackRow
            key={item.track.id}
            track={item.track}
            index={index}
            isCurrent={item.track.id === current?.id}
            isPlaying={player.isPlaying}
            note={isMine ? undefined : lang('MusicAddedBy', { name: item.adder })}
            onPlay={handlePlayAdded}
            onDelete={isMine ? handleDeleteAdded : undefined}
          />
        ))}
      </ul>
    );
  }

  function renderAlbums(albums: MusicAlbum[]) {
    return (
      <div className={styles.tiles} data-music-albums>
        {albums.map((album) => (
          <button key={album.id} type="button" className={styles.tile} data-id={album.id} onClick={handleOpenAlbum}>
            <MusicCover coverId={album.coverId} toneId={album.id} size={120} className={styles.tileCover} />
            <span className={styles.tileTitle}>{album.title}</span>
            <span className={buildClassName(kit.muted, kit.small, styles.tileTitle)}>{album.artist}</span>
          </button>
        ))}
      </div>
    );
  }

  function renderArtists(artists: MusicArtist[]) {
    return (
      <ul className={styles.tracks} data-music-artists>
        {artists.map((artist) => (
          <li key={artist.id} className={styles.track}>
            <button type="button" className={styles.trackMain} data-id={artist.id} onClick={handleOpenArtist}>
              <MusicCover coverId={artist.coverId} toneId={artist.id} size={40} className={styles.trackCover} />
              <span className={styles.trackText}>
                <span className={styles.trackTitle}>{artist.name}</span>
                <span className={buildClassName(kit.muted, kit.small)}>
                  {lang('MusicAlbumsCount', { count: artist.albumCount }, { pluralValue: artist.albumCount })}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  // Над находками каталога «ничего не найдено» остаётся строкой
  function renderEmpty(isLine: boolean) {
    if (isLine) return <div className={kit.muted} data-music-empty>{lang('MusicNothingFound')}</div>;
    if (view.kind === 'search') return <PvEmpty title={lang('MusicNothingFound')} data-music-empty />;
    if (view.kind === 'starred' || view.kind === 'added') {
      return <PvEmpty text={lang(EMPTY_KEYS[view.kind])} data-music-empty />;
    }
    return <PvEmpty title={lang('MusicEmpty')} data-music-empty />;
  }

  function renderContent() {
    if (view.kind === 'queue') return <MusicQueue />;
    if (view.kind === 'offline') return <MusicOffline currentTrackId={current?.id} isPlaying={player.isPlaying} />;
    if (view.kind === 'playlists') {
      return (
        <MusicPlaylists
          playlistId={view.id}
          currentTrackId={current?.id}
          isPlaying={player.isPlaying}
          onOpen={handleOpenPlaylist}
        />
      );
    }
    if (!content) return <PvSkeleton onRetry={handleRetry} />;
    if (content.isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
    const { tracks, albums, artists } = content;
    const added = (content.added || []).filter((item) => item.track.id);
    const isEmpty = !tracks?.length && !albums?.length && !artists?.length && !added.length;
    const total = splitListTime((tracks || []).reduce((sum, track) => sum + track.durationSecs, 0));
    const isFetchShown = view.kind === 'search' && info?.isFetchEnabled;
    // Пустая библиотека сервера (доски `RpMusicB`, `ZdMusicX`): вместо главной — приглашение найти первый трек
    if (view.kind === 'home' && isEmpty && !recent.length) {
      return (
        <PvEmpty
          title={lang('MusicEmptyTitle')}
          text={lang('MusicEmptyText')}
          actionText={info?.isFetchEnabled ? lang('MusicEmptyFind') : undefined}
          data-music-empty
          onAction={handleFocusSearch}
        />
      );
    }
    return (
      <>
        {view.kind === 'home' && (
          <>
            <section className={styles.mix} data-music-mix>
              <div className={kit.grow}>
                <div className={kit.caps}>{lang('MusicMixTitle')}</div>
                <div className={styles.mixText}>{lang('MusicMixSoon')}</div>
              </div>
            </section>
            {Boolean(recent.length) && (
              <>
                <div className={kit.caps}>{lang('MusicRecentlyPlayed')}</div>
                {renderTracks(recent.slice(0, 5), handlePlayRecent)}
              </>
            )}
            <div className={kit.caps}>{lang('MusicNewOnServer')}</div>
            {Boolean(added.length) && renderAdded(added, false)}
          </>
        )}
        {view.kind === 'added' && info && (
          <div className={buildClassName(kit.muted, kit.small)} data-music-usage>
            {lang('MusicAddedUsage', {
              today: info.addedToday,
              perDay: info.addPerDay,
              used: renderSize(info.usedBytes),
              quota: renderSize(info.quotaBytes),
            })}
          </div>
        )}
        {view.kind === 'added' && Boolean(added.length) && renderAdded(added, true)}
        {content.title && (
          <div className={styles.listHead}>
            <div className={kit.grow}>
              <h2 className={styles.listTitle}>{content.title}</h2>
              {content.subtitle && <div className={kit.muted}>{content.subtitle}</div>}
            </div>
            {Boolean(tracks?.length) && (
              <>
                <span className={buildClassName(kit.muted, kit.small)}>
                  {lang('MusicListTime', { hours: total.hours, minutes: total.minutes })}
                </span>
                <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handlePlayAll}>
                  {lang('MusicPlayAll')}
                </button>
                <button type="button" className={kit.btn} data-music-save-offline onClick={handleSaveOffline}>
                  {lang('MusicOfflineSave')}
                </button>
              </>
            )}
          </div>
        )}
        {isEmpty && renderEmpty(Boolean(isFetchShown))}
        {Boolean(artists?.length) && renderArtists(artists)}
        {Boolean(albums?.length) && renderAlbums(albums)}
        {Boolean(tracks?.length) && renderTracks(tracks, handlePlayFrom)}
        {isFetchShown && (
          <MusicFetch query={view.query} onPlayLibraryTrack={handlePlayLibraryTrack} />
        )}
      </>
    );
  }

  function renderBody() {
    if (!info || info.isFailed) return <PvLoading onRetry={handleRetry} />;
    if (!info.isEnabled) return <PvEmpty text={lang('MusicNotConnected')} data-music-off />;
    return (
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label={lang('ParvaneModuleMusic')}>
          {NAV.map((item) => (
            <button
              key={item.kind}
              type="button"
              className={buildClassName(styles.navItem, view.kind === item.kind && styles.navItemOn)}
              aria-current={view.kind === item.kind ? 'page' : undefined}
              data-view={item.kind}
              onClick={handleNav}
            >
              <ParvaneIcon name={item.icon} isSmall />
              <span>{lang(item.titleKey)}</span>
            </button>
          ))}
          <button
            type="button"
            className={buildClassName(styles.navItem, view.kind === 'playlists' && styles.navItemOn)}
            aria-current={view.kind === 'playlists' ? 'page' : undefined}
            data-view="playlists"
            onClick={handleNav}
          >
            <ParvaneIcon name="list" isSmall />
            <span>{lang('MusicPlaylists')}</span>
          </button>
          <button
            type="button"
            className={buildClassName(styles.navItem, view.kind === 'offline' && styles.navItemOn)}
            aria-current={view.kind === 'offline' ? 'page' : undefined}
            data-view="offline"
            onClick={handleNav}
          >
            <ParvaneIcon name="cloud" isSmall />
            <span>{lang('MusicOffline')}</span>
          </button>
          {info.isFetchEnabled && (
            <button
              type="button"
              className={buildClassName(styles.navItem, view.kind === 'added' && styles.navItemOn)}
              aria-current={view.kind === 'added' ? 'page' : undefined}
              data-view="added"
              onClick={handleNav}
            >
              <ParvaneIcon name="upload" isSmall />
              <span>{lang('MusicAdded')}</span>
            </button>
          )}
          <button
            type="button"
            className={buildClassName(styles.navItem, styles.navQueue, view.kind === 'queue' && styles.navItemOn)}
            data-view="queue"
            onClick={handleNav}
          >
            <ParvaneIcon name="list" isSmall />
            <span>{lang('MusicPlayer')}</span>
          </button>
        </nav>
        <div className={buildClassName(styles.main, 'custom-scroll')} data-music-view={view.kind}>
          {view.kind !== 'queue' && (
            <input
              ref={searchRef}
              className={buildClassName(kit.input, styles.search)}
              type="search"
              value={query}
              placeholder={lang('MusicSearchPlaceholder')}
              aria-label={lang('MusicSearchPlaceholder')}
              onChange={handleQueryChange}
            />
          )}
          {pickerTrack && <MusicPlaylistPicker key={pickerTrack.id} track={pickerTrack} onClose={handleClosePicker} />}
          {renderContent()}
        </div>
        <aside className={styles.side}>
          <MusicQueue />
        </aside>
      </div>
    );
  }

  return (
    <div id="ParvaneMusic" className={styles.root} data-music-enabled={info ? String(info.isEnabled) : 'loading'}>
      <header className={styles.header}>
        <h1 className={styles.title}>{lang('ParvaneModuleMusic')}</h1>
        <span className={buildClassName(kit.muted, kit.small)}>{lang('MusicServerLibrary')}</span>
      </header>
      {!isOnline && <PvOfflineBar text={lang('PvOfflineMusic')} onRetry={handleRetry} />}
      {renderBody()}
      <MusicSendDialog track={sentTrack} onClose={handleCloseSend} />
    </div>
  );
};

export default memo(Music);
