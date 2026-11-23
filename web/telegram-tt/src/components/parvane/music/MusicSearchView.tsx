import type { TeactNode } from '../../../lib/teact/teact';
import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { MusicInfo, MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicSearchFound } from './musicSearchLists';

import buildClassName from '../../../util/buildClassName';
import { getSharedPlaylists } from './shared/musicShared';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { getPlaylists } from './musicPlaylists';
import { buildSearchLists } from './musicSearchLists';
import {
  getMusicQuery, openMusicView, requestMusicAdd, setMusicQuery,
} from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSheet from '../notes/PvSheet';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCatalogRow from './MusicCatalogRow';
import MusicCover from './MusicCover';
import MusicLoadMore from './MusicLoadMore';
import MusicTrackRow from './MusicTrackRow';

import styles from './MusicSearch.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
  // «+ → Найти в каталоге»: курсор в поле (меняется при каждом запросе)
  focusToken?: number;
  onSendToChat: (track: MusicTrack) => void;
};

type Filter = 'all' | 'tracks' | 'artists' | 'albums' | 'playlists';
type Source = 'everywhere' | 'server' | 'catalog';

const SEARCH_DELAY_MS = 300;
const FILTERS: Filter[] = ['all', 'tracks', 'artists', 'albums', 'playlists'];
const FILTER_KEYS = {
  all: 'MusicFilterAll',
  tracks: 'MusicFilterTracks',
  artists: 'MusicArtists',
  albums: 'MusicAlbums',
  playlists: 'MusicPlaylists',
} as const;
const SOURCES: Source[] = ['everywhere', 'server', 'catalog'];
const SOURCE_KEYS = {
  everywhere: ['MusicSourceEverywhere', 'MusicSourceEverywhereHint'],
  server: ['MusicSourceServer', 'MusicSourceServerHint'],
  catalog: ['MusicSourceCatalog', 'MusicSourceCatalogHint'],
} as const;
// Треков в «Всё» (доска `MusicSearch-02`)
const ALL_TRACKS = 4;

// Parvane (макет «Музыки» 23 ноя, доски `MusicSearch`, `DeskMusic-02`): поиск — сервер и каталог одним списком.
// Пустое поле — «Недавнее» (история на сервере) и «Обзор». С запросом — чипы «Всё · Треки · Исполнители · Альбомы ·
// Плейлисты» и «Источник»: «Лучший результат», треки (сервер первым, каталог — серым с облачком), исполнители и
// альбомы лентой, плейлисты. Каталог не ответил — показываем сервер с пометкой
const MusicSearchView = ({
  info, isPhone, focusToken, onSendToChat,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const query = useDerivedState(getMusicQuery);
  const player = useDerivedState(getMusicPlayer);
  const playlists = useDerivedState(getPlaylists);
  const shared = useDerivedState(getSharedPlaylists);
  const current = getCurrentTrack(player);
  const [effective, setEffective] = useState(query.trim());
  const [filter, setFilter] = useState<Filter>('all');
  const [source, setSource] = useState<Source>('everywhere');
  const [isSourceOpen, setIsSourceOpen] = useState(false);
  const [found, setFound] = useState<MusicSearchFound>();
  const [history, setHistory] = useState<string[]>();
  const requestRef = useRef(0);
  const hasCatalog = info.isFetchEnabled;

  useLayoutEffect(() => {
    if (isPhone) inputRef.current?.focus();
  }, [focusToken, isPhone]);

  useEffect(() => {
    const timer = window.setTimeout(() => setEffective(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (effective) return;
    void callMusic('parvaneMusicSearchHistory').then(setHistory, () => setHistory([]));
  }, [effective]);

  const search = useLastCallback((text: string) => {
    const id = ++requestRef.current;
    const patch = (change: Partial<MusicSearchFound>) => {
      if (id === requestRef.current) setFound((previous) => ({ ...previous, ...change, query: text }));
    };
    setFound((previous) => (previous?.query === text ? previous : { query: text }));
    void callMusic('parvaneMusicSearch', { query: text })
      .then((server) => patch({ server }), () => patch({ isServerFailed: true }));
    if (!hasCatalog) return;
    void callMusic('parvaneMusicCatalogSearch', { query: text })
      .then((catalog) => patch({ catalog, isCatalogFailed: false }), () => patch({ isCatalogFailed: true }));
  });

  useEffect(() => {
    if (effective) search(effective);
  }, [effective, search]);

  const handleMore = useLastCallback(async () => {
    const catalog = found?.catalog;
    if (!found || !catalog?.hasMore) return;
    const text = found.query;
    const page = await callMusic('parvaneMusicCatalogSearch', { query: text, offset: catalog.nextOffset })
      .catch(() => undefined);
    if (!page) return;
    setFound((previous) => (previous?.query === text && previous.catalog ? {
      ...previous,
      catalog: {
        ...previous.catalog,
        tracks: [...previous.catalog.tracks, ...page.tracks],
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
      },
    } : previous));
  });

  const remember = useLastCallback(() => {
    if (effective.length < 2) return;
    void callMusic('parvaneMusicSearchRemember', { query: effective }).catch(() => undefined);
  });

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setMusicQuery(e.currentTarget.value));
  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') remember();
  });
  const handleFilter = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setFilter(e.currentTarget.dataset.filter as Filter);
  });
  const handleOpenSource = useLastCallback(() => setIsSourceOpen(true));
  const handleCloseSource = useLastCallback(() => setIsSourceOpen(false));
  const handleSource = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setSource(e.currentTarget.dataset.source as Source);
    setIsSourceOpen(false);
  });
  const handlePickHistory = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setMusicQuery(e.currentTarget.dataset.query!);
  });
  const handleForget = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const forgotten = e.currentTarget.dataset.query!;
    setHistory((previous) => previous?.filter((item) => item !== forgotten));
    void callMusic('parvaneMusicSearchForget', { query: forgotten }).catch(() => undefined);
  });
  const handleClearHistory = useLastCallback(() => {
    setHistory([]);
    void callMusic('parvaneMusicSearchForget', {}).catch(() => undefined);
  });
  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id } = e.currentTarget.dataset;
    remember();
    openMusicView({ kind: kind as 'album', id: id! });
  });
  const handleOpenAlbums = useLastCallback(() => openMusicView({ kind: 'albums' }));
  const handleOpenArtists = useLastCallback(() => openMusicView({ kind: 'artists' }));
  const handleFilterArtists = useLastCallback(() => setFilter('artists'));
  const handleFilterAlbums = useLastCallback(() => setFilter('albums'));
  const handleLink = useLastCallback(() => requestMusicAdd('link'));
  const handleFile = useLastCallback(() => requestMusicAdd('file'));
  const handleRetry = useLastCallback(() => search(effective));

  const shown = found?.query === effective ? found : undefined;
  const withServer = source !== 'catalog';
  const withCatalog = source !== 'server' && hasCatalog;
  const serverTracks = (withServer && shown?.server?.tracks) || [];
  const lists = useMemo(() => buildSearchLists(shown, withServer, withCatalog), [shown, withServer, withCatalog]);
  const matchedPlaylists = useMemo(() => {
    const text = effective.toLowerCase();
    if (!text) return [];
    return [
      ...playlists.filter((item) => item.name.toLowerCase().includes(text)).map((item) => ({
        key: `playlist:${item.id}`, kind: 'playlist', id: item.id, name: item.name, count: item.count,
      })),
      ...shared.filter((item) => item.name.toLowerCase().includes(text)).map((item) => ({
        key: `shared:${item.id}`, kind: 'shared', id: item.id, name: item.name, count: item.trackCount,
      })),
    ];
  }, [effective, playlists, shared]);

  const handlePlay = useLastCallback((index: number) => {
    remember();
    playTracks(serverTracks, index, { source: { kind: 'search', name: effective } });
  });
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    setFound((previous) => previous?.server && {
      ...previous,
      server: {
        ...previous.server,
        tracks: previous.server.tracks.map((item) => (item.id === track.id ? { ...item, isStarred } : item)),
      },
    });
    void setTrackStarred(track, isStarred);
  });

  function renderStart() {
    return (
      <>
        {Boolean(history?.length) && (
          <section className={styles.section}>
            <div className={styles.head}>
              <h2 className={styles.headTitle}>{lang('MusicRecent')}</h2>
              <button type="button" className={styles.headAction} onClick={handleClearHistory}>
                {lang('MusicClear')}
              </button>
            </div>
            <div className={styles.list} data-music-history>
              {history.map((item) => (
                <div key={item} className={styles.historyRow}>
                  <button type="button" className={styles.historyMain} data-query={item} onClick={handlePickHistory}>
                    <span className={styles.historyIcon}><ParvaneIcon name="search" isSmall /></span>
                    <span className={styles.listTitle}>{item}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.historyForget}
                    aria-label={lang('MusicForgetQuery', { query: item })}
                    data-query={item}
                    onClick={handleForget}
                  >
                    <ParvaneIcon name="close" isSmall />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className={styles.section}>
          <h2 className={styles.headTitle}>{lang('MusicBrowse')}</h2>
          <div className={styles.browse}>
            <button
              type="button"
              className={buildClassName(styles.browseTile, styles.toneA)}
              onClick={handleOpenAlbums}
            >
              <span className={styles.browseTitle}>{lang('MusicNewOnServer')}</span>
              <span className={styles.browseSub}>
                {lang('MusicTracksCount', { count: info.libraryTracks }, { pluralValue: info.libraryTracks })}
              </span>
            </button>
            <button
              type="button"
              className={buildClassName(styles.browseTile, styles.toneB)}
              onClick={handleOpenArtists}
            >
              <span className={styles.browseTitle}>{lang('MusicArtists')}</span>
              <span className={styles.browseSub}>{info.libraryArtists}</span>
            </button>
          </div>
        </section>
      </>
    );
  }

  function renderBest() {
    const { best } = lists;
    if (!best) return undefined;
    return (
      <section className={styles.section}>
        <h2 className={styles.headTitle}>{lang('MusicBestResult')}</h2>
        <button
          type="button"
          className={styles.best}
          data-kind={best.kind}
          data-id={best.id}
          data-music-best
          onClick={handleOpen}
        >
          <MusicCover
            coverId={best.coverId}
            coverUrl={best.coverUrl}
            toneId={best.id}
            size={isPhone ? 76 : 86}
            glyph={best.glyph}
            isRound={best.glyph === 'mic'}
            className={styles.bestCover}
          />
          <span className={styles.bestText}>
            <span className={styles.bestTitle}>{best.title}</span>
            <span className={styles.bestSub}>
              {[lang(best.glyph === 'mic' ? 'MusicKindArtist' : 'MusicKindAlbum'), best.sub]
                .filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className={styles.bestPlay} aria-hidden><ParvaneIcon name="play" /></span>
        </button>
      </section>
    );
  }

  function renderTracks(limit?: number) {
    const { catalogTracks } = lists;
    const serverShown = limit ? serverTracks.slice(0, limit) : serverTracks;
    const catalogShown = limit ? catalogTracks.slice(0, Math.max(0, limit - serverShown.length)) : catalogTracks;
    if (!serverShown.length && !catalogShown.length) return undefined;
    return (
      <ul className={styles.rows} data-music-tracks>
        {serverShown.map((track, index) => (
          <MusicTrackRow
            key={`track:${track.id}`}
            track={track}
            index={index}
            isCurrent={track.id === current?.id}
            isPlaying={player.isPlaying}
            canQueue
            canSaveOffline
            onPlay={handlePlay}
            onStar={handleStar}
            onSendToChat={onSendToChat}
          />
        ))}
        {catalogShown.map((track) => (
          <MusicCatalogRow key={`catalog:${track.ref || `${track.artist}:${track.title}`}`} track={track} />
        ))}
      </ul>
    );
  }

  function renderArtists(isStrip?: boolean) {
    if (!lists.artists.length) return undefined;
    return (
      <div className={isStrip ? styles.strip : styles.grid} data-music-artists>
        {lists.artists.map((artist) => (
          <button
            key={artist.key}
            type="button"
            className={buildClassName(styles.tile, styles.tileRound)}
            data-kind={artist.kind}
            data-id={artist.id}
            onClick={handleOpen}
          >
            <MusicCover
              coverId={artist.coverId}
              coverUrl={artist.coverUrl}
              toneId={artist.id}
              size={96}
              glyph="mic"
              isRound
              className={styles.tileCover}
            />
            <span className={styles.tileTitle}>{artist.name}</span>
            <span className={styles.tileSub}>
              {lang(artist.isServer ? 'MusicOnServerShort' : 'MusicInCatalogShort')}
            </span>
          </button>
        ))}
      </div>
    );
  }

  function renderAlbums(isStrip?: boolean) {
    if (!lists.albums.length) return undefined;
    return (
      <div className={isStrip ? styles.strip : styles.grid} data-music-albums>
        {lists.albums.map((album) => (
          <button
            key={album.key}
            type="button"
            className={styles.tile}
            data-kind={album.kind}
            data-id={album.id}
            onClick={handleOpen}
          >
            <MusicCover
              coverId={album.coverId}
              coverUrl={album.coverUrl}
              toneId={album.id}
              size={96}
              glyph="disc"
              className={styles.tileCover}
            />
            <span className={styles.tileTitle}>{album.title}</span>
            <span className={styles.tileSub}>{album.artist}</span>
          </button>
        ))}
      </div>
    );
  }

  function renderPlaylists() {
    if (!matchedPlaylists.length) return undefined;
    return (
      <div className={styles.list} data-music-playlists-found>
        {matchedPlaylists.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.listRow}
            data-kind={item.kind}
            data-id={item.id}
            onClick={handleOpen}
          >
            <MusicCover
              toneId={item.id}
              size={46}
              glyph={item.kind === 'shared' ? 'users' : 'list'}
              className={styles.listCover}
            />
            <span className={styles.listText}>
              <span className={styles.listTitle}>{item.name}</span>
              <span className={styles.listSub}>
                {lang('MusicTracksCount', { count: item.count }, { pluralValue: item.count })}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  function renderSection(title: string, body: TeactNode, onAll?: NoneToVoidFunction) {
    if (!body) return undefined;
    return (
      <section className={styles.section}>
        <div className={styles.head}>
          <h2 className={styles.headTitle}>{title}</h2>
          {onAll && (
            <button type="button" className={styles.headAction} onClick={onAll}>{lang('MusicShowAll')}</button>
          )}
        </div>
        {body}
      </section>
    );
  }

  function renderEmpty() {
    return (
      <div className={styles.empty} data-music-empty="search">
        <h2 className={styles.emptyTitle}>{lang('MusicNothingFound', { query: effective })}</h2>
        <p className={styles.emptyText}>{lang('MusicNothingFoundHint')}</p>
        <div className={styles.emptyActions}>
          {info.isFetchEnabled && (
            <button type="button" className={styles.emptyButton} onClick={handleLink}>
              <ParvaneIcon name="link" isSmall />
              {lang('MusicLinkShort')}
            </button>
          )}
          {info.isUploadEnabled && (
            <button type="button" className={styles.emptyButton} onClick={handleFile}>
              <ParvaneIcon name="upload" isSmall />
              {lang('MusicOwnFile')}
            </button>
          )}
        </div>
      </div>
    );
  }

  function renderResults() {
    if (!shown || (!shown.server && !shown.isServerFailed && !shown.catalog)) return <PvSkeleton />;
    const isCatalogDown = withCatalog && shown.isCatalogFailed;
    const isWaitingCatalog = withCatalog && !shown.catalog && !shown.isCatalogFailed;
    const isEmpty = !serverTracks.length && !lists.catalogTracks.length && !lists.artists.length
      && !lists.albums.length && !matchedPlaylists.length;
    return (
      <>
        {isCatalogDown && (
          <div className={styles.notice} role="status" data-music-catalog-down>
            <ParvaneIcon name="cloudLine" isSmall />
            <span className={styles.noticeText}>{lang('MusicCatalogDown')}</span>
            <button type="button" className={styles.headAction} onClick={handleRetry}>{lang('MusicRetry')}</button>
          </div>
        )}
        {isEmpty && !isWaitingCatalog && renderEmpty()}
        {filter === 'all' && !isEmpty && (
          <>
            <div className={styles.top}>
              {renderBest()}
              {renderSection(lang('MusicFilterTracks'), renderTracks(ALL_TRACKS))}
            </div>
            {renderSection(lang('MusicArtists'), renderArtists(true), handleFilterArtists)}
            {renderSection(lang('MusicAlbums'), renderAlbums(true), handleFilterAlbums)}
            {renderSection(lang('MusicPlaylists'), renderPlaylists())}
          </>
        )}
        {filter === 'tracks' && renderTracks()}
        {filter === 'artists' && renderArtists()}
        {filter === 'albums' && renderAlbums()}
        {filter === 'playlists' && renderPlaylists()}
        {filter === 'tracks' && withCatalog && shown.catalog?.hasMore && (
          <>
            <div className={styles.more}>
              <span className={styles.moreRing} />
              {lang('MusicLoadingMore')}
            </div>
            <MusicLoadMore onMore={handleMore} />
          </>
        )}
        {isWaitingCatalog && <PvSkeleton />}
      </>
    );
  }

  return (
    <div className={buildClassName(styles.root, isPhone && styles.rootPhone)} data-music-search>
      {isPhone && (
        <div className={styles.field}>
          <ParvaneIcon name="search" isSmall className={styles.fieldIcon} />
          <input
            ref={inputRef}
            className={styles.fieldInput}
            type="search"
            value={query}
            placeholder={lang('MusicSearchWhat')}
            aria-label={lang('MusicSearchWhat')}
            onChange={handleQuery}
            onKeyDown={handleKeyDown}
          />
        </div>
      )}
      {Boolean(effective) && (
        <div className={styles.chips} role="group" aria-label={lang('MusicFilterLabel')}>
          <div className={styles.chipsScroll}>
            {FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className={buildClassName(styles.chip, filter === value && styles.chipOn)}
                aria-pressed={filter === value}
                data-filter={value}
                onClick={handleFilter}
              >
                {lang(FILTER_KEYS[value])}
              </button>
            ))}
          </div>
          {hasCatalog && (
            <button
              type="button"
              className={buildClassName(styles.filterButton, source !== 'everywhere' && styles.filterOn)}
              aria-label={lang('MusicSource')}
              data-music-source-open
              onClick={handleOpenSource}
            >
              <ParvaneIcon name="filter" isSmall />
            </button>
          )}
        </div>
      )}
      {effective ? renderResults() : renderStart()}
      <PvSheet
        isOpen={isSourceOpen}
        title={lang('MusicSource')}
        subtitle={lang('MusicSourceHint')}
        onClose={handleCloseSource}
      >
        <div className={styles.list} role="radiogroup" data-music-sources>
          {SOURCES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={source === value}
              className={styles.listRow}
              data-source={value}
              onClick={handleSource}
            >
              <span className={buildClassName(styles.radio, source === value && styles.radioOn)} />
              <span className={styles.listText}>
                <span className={styles.listTitle}>{lang(SOURCE_KEYS[value][0])}</span>
                <span className={styles.listSub}>{lang(SOURCE_KEYS[value][1])}</span>
              </span>
            </button>
          ))}
        </div>
      </PvSheet>
    </div>
  );
};

export default memo(MusicSearchView);
