import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';

import type { MusicAlbum, MusicArtist, MusicTrack } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { getParvaneSection } from '../../../util/parvaneSection';
import { splitListTime } from './musicFormat';
import {
  addToQueue, callMusic, getCurrentTrack, getMusicInfo, getMusicPlayer, getMusicRecent, loadMusicInfo, playTracks,
  restoreMusicQueue, setTrackStarred,
} from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import MusicCover from './MusicCover';
import MusicQueue from './MusicQueue';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type View =
  | { kind: 'home' | 'starred' | 'artists' | 'albums' | 'queue' }
  | { kind: 'album'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'search'; query: string };

type Content = {
  tracks?: MusicTrack[];
  albums?: MusicAlbum[];
  artists?: MusicArtist[];
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
const EMPTY_KEYS = { search: 'MusicNothingFound', starred: 'MusicStarredEmpty' } as const;

/** Содержимое вида с сервера. Библиотека целиком — поиск с пустой строкой. */
async function fetchContent(view: View): Promise<Content> {
  switch (view.kind) {
    case 'home':
      return { albums: await callMusic('parvaneMusicRecent') };
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
  const loadIdRef = useRef(0);
  const current = getCurrentTrack(player);
  const content = loaded?.view === view ? loaded.content : undefined;
  const isShown = section === 'music';

  useEffect(() => {
    if (!isShown || info) return;
    void loadMusicInfo().then((loaded) => {
      if (loaded.isEnabled) void restoreMusicQueue();
    });
  }, [isShown, info]);

  const load = useLastCallback(async (next: View) => {
    const id = ++loadIdRef.current;
    const fetched = await fetchContent(next).catch((): Content => ({ isFailed: true }));
    // Пока шёл запрос, открыли другой вид
    if (id === loadIdRef.current) setLoaded({ view: next, content: fetched });
  });

  const isEnabled = info?.isEnabled;
  useEffect(() => {
    if (isShown && isEnabled) void load(view);
  }, [isShown, isEnabled, view, load]);

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

  const handleQueryChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handleNav = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
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
  const handlePlayAll = useLastCallback(() => handlePlayFrom(0));
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
            onPlay={onPlay}
            onStar={handleStar}
            onAddNext={handleAddNext}
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

  function renderContent() {
    if (view.kind === 'queue') return <MusicQueue />;
    if (!content) return <div className={kit.muted}>{lang('MusicLoading')}</div>;
    if (content.isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
    const { tracks, albums, artists } = content;
    const isEmpty = !tracks?.length && !albums?.length && !artists?.length;
    const total = splitListTime((tracks || []).reduce((sum, track) => sum + track.durationSecs, 0));
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
          </>
        )}
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
              </>
            )}
          </div>
        )}
        {isEmpty && (
          <div className={kit.muted} data-music-empty>
            {lang(EMPTY_KEYS[view.kind as keyof typeof EMPTY_KEYS] || 'MusicEmpty')}
          </div>
        )}
        {Boolean(artists?.length) && renderArtists(artists!)}
        {Boolean(albums?.length) && renderAlbums(albums!)}
        {Boolean(tracks?.length) && renderTracks(tracks!, handlePlayFrom)}
      </>
    );
  }

  function renderBody() {
    if (!info) return <div className={buildClassName(styles.main, kit.muted)}>{lang('MusicLoading')}</div>;
    if (!info.isEnabled) {
      return <div className={buildClassName(styles.main, kit.muted)} data-music-off>{lang('MusicNotConnected')}</div>;
    }
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
              className={buildClassName(kit.input, styles.search)}
              type="search"
              value={query}
              placeholder={lang('MusicSearchPlaceholder')}
              aria-label={lang('MusicSearchPlaceholder')}
              onChange={handleQueryChange}
            />
          )}
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
      {renderBody()}
    </div>
  );
};

export default memo(Music);
