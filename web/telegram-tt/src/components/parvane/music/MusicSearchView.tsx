import {
  memo, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type {
  MusicAlbum, MusicArtist, MusicInfo, MusicTrack,
} from '../../../api/parvane/musicApi';
import type { MusicSearchFilter } from './musicLibrary';

import buildClassName from '../../../util/buildClassName';
import { buildSearchRows, mergePage } from './musicLibrary';
import { saveTracksOffline } from './musicOffline';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { getMusicQuery, openMusicView, setMusicQuery } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSkeleton from '../notes/PvSkeleton';
import MusicSearchStart from './fetch/MusicSearchStart';
import MusicCover from './MusicCover';
import MusicFetch from './MusicFetch';
import MusicLoadMore from './MusicLoadMore';
import MusicSectionHead from './MusicSectionHead';
import MusicTrackRow from './MusicTrackRow';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  info: MusicInfo;
  isPhone?: boolean;
  // «+ → Найти и скачать»: курсор в поле (меняется при каждом запросе)
  focusToken?: number;
  onSendToChat: (track: MusicTrack) => void;
};

type Found = {
  query: string;
  tracks: MusicTrack[];
  albums: MusicAlbum[];
  artists: MusicArtist[];
  hasMore: boolean;
  isFailed?: boolean;
};

const SEARCH_DELAY_MS = 300;
const PAGE = 50;
const FILTERS: MusicSearchFilter[] = ['all', 'tracks', 'artists', 'albums'];
const FILTER_KEYS = {
  all: 'MusicFilterAll', tracks: 'MusicFilterTracks', artists: 'MusicArtists', albums: 'MusicAlbums',
} as const;

// Parvane (spec 041, доски `MusicSearch`, `DeskMusicMore`, `ZpMusicX`): поиск по библиотеке сервера — поле, чипы
// «Всё / Треки / Исполнители / Альбомы», найденное одним списком «На сервере · N»; ниже — «Нет на сервере»
// («Найти и скачать», `MusicFetch`)
const MusicSearchView = ({
  info, isPhone, focusToken, onSendToChat,
}: OwnProps) => {
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();
  const query = useDerivedState(getMusicQuery);
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const [effective, setEffective] = useState(query.trim());
  const [filter, setFilter] = useState<MusicSearchFilter>('all');
  const [found, setFound] = useState<Found>();
  const requestRef = useRef(0);

  // Курсор в поле в кадр появления: набранное сразу после открытия не теряется
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    const timer = window.setTimeout(() => setEffective(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const fetchPage = useLastCallback(async (text: string, offset: number) => {
    const id = ++requestRef.current;
    const page = await callMusic('parvaneMusicSearch', { query: text, offset }).catch(() => undefined);
    if (id !== requestRef.current) return;
    if (!page) {
      setFound({
        query: text, tracks: [], albums: [], artists: [], hasMore: false, isFailed: true,
      });
      return;
    }
    const hasMore = page.tracks.length >= PAGE || page.albums.length >= PAGE || page.artists.length >= PAGE;
    setFound((previous) => (offset && previous?.query === text ? {
      query: text,
      tracks: mergePage(previous.tracks, page.tracks),
      albums: mergePage(previous.albums, page.albums),
      artists: mergePage(previous.artists, page.artists),
      hasMore,
    } : { query: text, ...page, hasMore }));
  });

  useEffect(() => {
    if (effective) void fetchPage(effective, 0);
  }, [effective, fetchPage]);

  const handleMore = useLastCallback(() => {
    if (!found?.hasMore) return;
    void fetchPage(found.query, Math.max(found.tracks.length, found.albums.length, found.artists.length));
  });

  const handleFilter = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setFilter(e.currentTarget.dataset.filter as MusicSearchFilter);
  });

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setMusicQuery(e.currentTarget.value));
  const handleBack = useLastCallback(() => {
    setMusicQuery('');
    openMusicView({ kind: 'home' }, true);
  });

  const shown = found?.query === effective ? found : undefined;
  const rows = useMemo(() => (shown ? buildSearchRows(shown, filter) : []), [shown, filter]);
  const playable = useMemo(() => rows.filter((row) => row.kind === 'track')
    .map((row) => shown!.tracks.find((track) => track.id === row.id)!), [rows, shown]);

  const handlePlay = useLastCallback((index: number) => {
    playTracks(playable, index, { source: { kind: 'search', name: effective } });
  });

  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    setFound((previous) => previous && {
      ...previous, tracks: previous.tracks.map((item) => (item.id === track.id ? { ...item, isStarred } : item)),
    });
    void setTrackStarred(track, isStarred);
  });

  const handleOpenAlbum = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'album', id: e.currentTarget.dataset.id! });
  });

  const handleOpenArtist = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    openMusicView({ kind: 'artist', id: e.currentTarget.dataset.id! });
  });

  // Альбом на компьютере — загрузка на устройство значком в строке (доска `DeskMusicMore`)
  const handleSaveAlbum = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const albumId = e.currentTarget.dataset.id!;
    const { tracks } = await callMusic('parvaneMusicAlbum', { albumId }).catch(() => ({ tracks: [] }));
    if (tracks.length) saveTracksOffline(tracks, { kind: 'album', id: albumId });
  });

  const handlePlayLibraryTrack = useLastCallback(async (trackId: string) => {
    const tracks = await callMusic('parvaneMusicTracks', { trackIds: [trackId] }).catch(() => []);
    const playableFound = tracks.filter(Boolean);
    if (playableFound.length) playTracks(playableFound, 0, { source: { kind: 'search', name: effective } });
  });

  function renderAlbum(album: MusicAlbum) {
    const count = lang('MusicTracksCount', { count: album.trackCount }, { pluralValue: album.trackCount });
    return (
      <li key={`album:${album.id}`} className={styles.track} data-album={album.id}>
        <button type="button" className={styles.trackMain} data-id={album.id} onClick={handleOpenAlbum}>
          <MusicCover coverId={album.coverId} toneId={album.id} size={40} glyph="disc" className={styles.trackCover} />
          <span className={styles.trackText}>
            <span className={styles.trackTitle}>{album.title}</span>
            <span className={buildClassName(kit.muted, kit.small, styles.trackArtist)}>
              {[lang('MusicKindAlbum'), album.artist, count].filter(Boolean).join(' · ')}
            </span>
          </span>
        </button>
        {isPhone ? (
          <ParvaneIcon name="right" isSmall className={styles.chevron} />
        ) : (
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('MusicOfflineSaveAlbum')}
            data-id={album.id}
            onClick={handleSaveAlbum}
          >
            <ParvaneIcon name="download" isSmall />
          </button>
        )}
      </li>
    );
  }

  function renderArtist(artist: MusicArtist) {
    return (
      <li key={`artist:${artist.id}`} className={styles.track} data-artist={artist.id}>
        <button type="button" className={styles.trackMain} data-id={artist.id} onClick={handleOpenArtist}>
          <MusicCover
            coverId={artist.coverId}
            toneId={artist.id}
            size={40}
            glyph="mic"
            isRound
            className={styles.trackCover}
          />
          <span className={styles.trackText}>
            <span className={styles.trackTitle}>{artist.name}</span>
            <span className={buildClassName(kit.muted, kit.small, styles.trackArtist)}>
              {[lang('MusicKindArtist'),
                lang('MusicAlbumsCount', { count: artist.albumCount }, { pluralValue: artist.albumCount })].join(' · ')}
            </span>
          </span>
        </button>
        <ParvaneIcon name="right" isSmall className={styles.chevron} />
      </li>
    );
  }

  function renderResults() {
    // Пустое поле: «Недавние запросы» и вход в «Загрузки на сервер» (доска `ZpMusicX`)
    if (!effective) return <MusicSearchStart onPick={setMusicQuery} />;
    if (!shown) return <PvSkeleton />;
    if (shown.isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
    let trackIndex = -1;
    return (
      <>
        <div className={kit.caps} data-music-found={rows.length}>
          {lang('MusicOnServer', { count: rows.length })}
        </div>
        {!rows.length && (
          <div className={kit.muted} data-music-empty="search">{lang('MusicNothingOnServer')}</div>
        )}
        {Boolean(rows.length) && (
          <ul className={styles.tracks} data-music-tracks>
            {rows.map((row) => {
              if (row.kind === 'album') return renderAlbum(shown.albums.find((item) => item.id === row.id)!);
              if (row.kind === 'artist') return renderArtist(shown.artists.find((item) => item.id === row.id)!);
              trackIndex += 1;
              const track = playable[trackIndex];
              return (
                <MusicTrackRow
                  key={`track:${track.id}`}
                  track={track}
                  index={trackIndex}
                  isCurrent={track.id === current?.id}
                  isPlaying={player.isPlaying}
                  prefix={lang('MusicKindTrack')}
                  trailing="offline"
                  canQueue
                  canSaveOffline
                  onPlay={handlePlay}
                  onStar={handleStar}
                  onSendToChat={onSendToChat}
                />
              );
            })}
          </ul>
        )}
        {shown.hasMore && <MusicLoadMore onMore={handleMore} />}
        <MusicFetch query={effective} onPlayLibraryTrack={handlePlayLibraryTrack} />
      </>
    );
  }

  return (
    <div className={styles.view} data-music-search>
      {/* Телефон: поиск — страница со своей шапкой «‹ Музыка / поиск» и подписью над полем (доска `ZpMusicX`) */}
      {isPhone && (
        <MusicSectionHead
          title={lang('ParvaneModuleMusic')}
          barSubtitle={lang('MusicSearch').toLowerCase()}
          isPhone
          onBack={handleBack}
        />
      )}
      <div className={styles.searchBar}>
        {isPhone && <div className={styles.searchLabel}>{lang('MusicSearchPlaceholder')}</div>}
        <input
          ref={inputRef}
          className={buildClassName(kit.input, styles.search)}
          type="search"
          value={query}
          placeholder={isPhone ? undefined : lang('MusicSearchPlaceholder')}
          aria-label={lang('MusicSearchPlaceholder')}
          onChange={handleQuery}
        />
        <div
          className={buildClassName(kit.chips, styles.searchFilter)}
          role="group"
          aria-label={lang('MusicFilterLabel')}
        >
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className={buildClassName(kit.chip, filter === value && kit.chipOn)}
              aria-pressed={filter === value}
              data-filter={value}
              onClick={handleFilter}
            >
              {lang(FILTER_KEYS[value])}
            </button>
          ))}
        </div>
      </div>
      {renderResults()}
    </div>
  );
};

export default memo(MusicSearchView);
