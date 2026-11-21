import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type {
  MusicAlbum, MusicArtist, MusicInfo, MusicTrack,
} from '../../../api/parvane/musicApi';
import type { MusicAlbumSort, MusicArtistSort } from './musicLibrary';

import buildClassName from '../../../util/buildClassName';
import { coverTone } from './musicFormat';
import { groupByLetter, sortAlbums, sortArtists } from './musicLibrary';
import { addToQueue, callMusic, playTracks } from './musicPlayer';
import { goBackMusic, openMusicView } from './musicView';
import useMusicData from './useMusicData';
import useMusicPages from './useMusicPages';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvSegment from '../notes/PvSegment';
import PvSkeleton from '../notes/PvSkeleton';
import MusicAlbumTiles from './MusicAlbumTiles';
import MusicCover from './MusicCover';
import MusicLoadMore from './MusicLoadMore';
import MusicSectionHead from './MusicSectionHead';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  kind: 'artists' | 'albums';
  info: MusicInfo;
  isPhone?: boolean;
};

const SEARCH_DELAY_MS = 300;
const PAGE = 50;
// Инициалы исполнителя на компьютере (доска `ZdMusicX`: «KM», «L», «ТП»)
const INITIALS_MAX = 2;

/** Треки исполнителя по его альбомам, в порядке альбомов — «Играть всё», «В очередь». */
export async function loadArtistTracks(albums: MusicAlbum[]) {
  const parts = await Promise.all(albums.map((album) => callMusic('parvaneMusicAlbum', { albumId: album.id })
    .then((reply) => reply.tracks).catch((): MusicTrack[] => [])));
  return parts.flat();
}

// Parvane (spec 041, доски `RpMusicA`, `RdMusic`, `ZdMusicX`): исполнители и альбомы всей библиотеки — шапка с
// числом, поиск по разделу, сортировка, подгрузка страниц при прокрутке. Телефон: «Библиотека» с переключателем
// «Исполнители · N / Альбомы · N», исполнители по буквам с указателем. Компьютер: исполнитель выбирается в списке,
// его альбомы — рядом
const MusicBrowseView = ({ kind, info, isPhone }: OwnProps) => {
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [effective, setEffective] = useState('');
  const [artistSort, setArtistSort] = useState<MusicArtistSort>('name');
  const [albumSort, setAlbumSort] = useState<MusicAlbumSort>('artist');
  const [selectedId, setSelectedId] = useState<string>();
  const isArtists = kind === 'artists';

  useEffect(() => {
    const timer = window.setTimeout(() => setEffective(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const artists = useMusicPages<MusicArtist>(isArtists ? `artists:${effective}` : undefined, async (offset) => {
    const page = await callMusic('parvaneMusicSearch', { query: effective, offset });
    return { items: page.artists, hasMore: page.artists.length >= PAGE };
  });
  const isNewest = albumSort === 'new' && !effective;
  const albums = useMusicPages<MusicAlbum>(
    isArtists ? undefined : `albums:${isNewest ? 'new' : effective}`,
    async (offset) => {
      const items = isNewest
        ? await callMusic('parvaneMusicRecent', { offset })
        : (await callMusic('parvaneMusicSearch', { query: effective, offset })).albums;
      return { items, hasMore: items.length >= PAGE };
    },
  );

  const sortedArtists = useMemo(() => sortArtists(artists.items || [], artistSort), [artists.items, artistSort]);
  const sortedAlbums = useMemo(
    () => (isNewest ? albums.items || [] : sortAlbums(albums.items || [])), [albums.items, isNewest],
  );
  const letters = useMemo(
    () => (isPhone && isArtists && artistSort === 'name' ? groupByLetter(sortedArtists) : undefined),
    [isPhone, isArtists, artistSort, sortedArtists],
  );

  const selected = !isPhone && isArtists
    ? sortedArtists.find((artist) => artist.id === selectedId) || sortedArtists[0] : undefined;
  const selectedAlbums = useMusicData(selected?.id, async () => {
    const reply = await callMusic('parvaneMusicArtist', { artistId: selected!.id });
    return reply.albums;
  });

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value));
  const handleKind = useLastCallback((value: 'artists' | 'albums') => openMusicView({ kind: value }, true));
  const handleArtistSort = useLastCallback((value: MusicArtistSort) => setArtistSort(value));
  const handleAlbumSort = useLastCallback((value: MusicAlbumSort) => setAlbumSort(value));

  const handleArtist = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { id } = e.currentTarget.dataset;
    if (isPhone || e.detail > 1) openMusicView({ kind: 'artist', id: id! });
    else setSelectedId(id);
  });

  const handleOpenSelected = useLastCallback(() => openMusicView({ kind: 'artist', id: selected!.id }));

  const handleLetter = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    document.getElementById(`music-letter-${e.currentTarget.dataset.letter}`)?.scrollIntoView({ block: 'start' });
  });

  const handlePlaySelected = useLastCallback(async () => {
    const tracks = await loadArtistTracks(selectedAlbums.data || []);
    playTracks(tracks, 0, { source: { kind: 'artist', name: selected?.name } });
  });

  const handleQueueSelected = useLastCallback(async () => {
    addToQueue(await loadArtistTracks(selectedAlbums.data || []), false);
  });

  function renderArtistFacts(artist: MusicArtist) {
    const albumsText = lang('MusicAlbumsCount', { count: artist.albumCount }, { pluralValue: artist.albumCount });
    const tracksText = artist.trackCount
      ? lang('MusicTracksCount', { count: artist.trackCount }, { pluralValue: artist.trackCount }) : undefined;
    return { albumsText, tracksText };
  }

  function renderArtistRow(artist: MusicArtist) {
    const { albumsText, tracksText } = renderArtistFacts(artist);
    const initials = artist.name.split(/\s+/).filter(Boolean).slice(0, INITIALS_MAX)
      .map((word) => word[0].toUpperCase()).join('');
    return (
      <li key={artist.id} className={buildClassName(styles.track, selected?.id === artist.id && styles.trackSelected)}>
        <button
          type="button"
          className={styles.trackMain}
          aria-current={selected?.id === artist.id ? 'true' : undefined}
          data-id={artist.id}
          onClick={handleArtist}
        >
          {isPhone ? (
            <MusicCover
              coverId={artist.coverId}
              toneId={artist.id}
              size={40}
              glyph="mic"
              isRound
              className={styles.trackCover}
            />
          ) : (
            <span className={styles.initials} style={`--cover-tone: ${coverTone(artist.id)}`}>{initials}</span>
          )}
          <span className={styles.trackText}>
            <span className={styles.trackTitle}>{artist.name}</span>
            {isPhone && (
              <span className={buildClassName(kit.muted, kit.small)}>
                {[artist.albumCount ? albumsText : undefined, tracksText].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
          {!isPhone && <span className={buildClassName(styles.trackCell, kit.muted, kit.small)}>{albumsText}</span>}
          {!isPhone && <span className={buildClassName(styles.trackCell, kit.muted, kit.small)}>{tracksText}</span>}
        </button>
      </li>
    );
  }

  function renderArtists() {
    if (!artists.isLoaded) return <PvSkeleton />;
    if (artists.isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
    if (!sortedArtists.length) {
      return <PvEmpty text={lang(effective ? 'MusicNothingFound' : 'MusicEmpty')} data-music-empty />;
    }
    if (letters) {
      return (
        <div className={styles.lettered}>
          <div className={styles.letterGroups} data-music-artists>
            {letters.map((group) => (
              <section key={group.letter} id={`music-letter-${group.letter}`} data-letter={group.letter}>
                <div className={kit.caps}>{group.letter}</div>
                <ul className={styles.tracks}>
                  {group.ids.map((id) => renderArtistRow(sortedArtists.find((artist) => artist.id === id)!))}
                </ul>
              </section>
            ))}
          </div>
          <nav className={styles.letterIndex} aria-label={lang('MusicLetterIndex')}>
            {letters.map((group) => (
              <button
                key={group.letter}
                type="button"
                className={styles.letterButton}
                data-letter={group.letter}
                onClick={handleLetter}
              >
                {group.letter}
              </button>
            ))}
          </nav>
        </div>
      );
    }
    return <ul className={styles.tracks} data-music-artists>{sortedArtists.map(renderArtistRow)}</ul>;
  }

  function renderSelected() {
    if (!selected) return undefined;
    return (
      <aside className={styles.artistPanel} data-music-artist-panel={selected.id}>
        <button type="button" className={buildClassName(kit.caps, styles.panelLink)} onClick={handleOpenSelected}>
          {lang('MusicArtistAlbums', { name: selected.name })}
        </button>
        <ul className={styles.tracks}>
          {(selectedAlbums.data || []).map((album) => (
            <li key={album.id} className={styles.track}>
              <span className={buildClassName(styles.trackMain, styles.trackStatic)}>
                <span className={styles.trackTitle}>{album.title}</span>
                <span className={buildClassName(kit.grow, kit.mono, kit.muted, kit.small)}>{album.year || ''}</span>
                <span className={buildClassName(kit.muted, kit.small)}>
                  {lang('MusicTracksCount', { count: album.trackCount }, { pluralValue: album.trackCount })}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} onClick={handlePlaySelected}>
            {lang('MusicListenAll')}
          </button>
          <button type="button" className={kit.btn} onClick={handleQueueSelected}>{lang('MusicToQueue')}</button>
        </div>
      </aside>
    );
  }

  function renderAlbums() {
    if (!albums.isLoaded) return <PvSkeleton />;
    if (albums.isFailed) return <div className={styles.error} role="alert">{lang('MusicLoadFailed')}</div>;
    if (!sortedAlbums.length) {
      return <PvEmpty text={lang(effective ? 'MusicNothingFound' : 'MusicEmpty')} data-music-empty />;
    }
    return <MusicAlbumTiles albums={sortedAlbums} />;
  }

  const total = isArtists ? info.libraryArtists : info.libraryAlbums;
  const search = (
    <input
      className={buildClassName(kit.input, styles.headSearch)}
      type="search"
      value={query}
      placeholder={lang(isArtists ? 'MusicFindArtist' : 'MusicFindAlbum')}
      aria-label={lang(isArtists ? 'MusicFindArtist' : 'MusicFindAlbum')}
      onChange={handleQuery}
    />
  );
  const sortControl = isArtists ? (
    <PvSegment
      items={[
        { value: 'name', label: lang('MusicSortByName') },
        { value: 'tracks', label: lang('MusicSortByTracks') },
      ]}
      value={artistSort}
      label={lang('MusicSortLabel')}
      onChange={handleArtistSort}
    />
  ) : (
    <PvSegment
      items={[
        { value: 'artist', label: lang('MusicSortByArtist') },
        { value: 'new', label: lang('MusicSortNew') },
      ]}
      value={albumSort}
      label={lang('MusicSortLabel')}
      onChange={handleAlbumSort}
    />
  );
  const pages = isArtists ? artists : albums;

  return (
    <div className={styles.view}>
      <MusicSectionHead
        title={isPhone || !total ? lang(isArtists ? 'MusicArtists' : 'MusicAlbums')
          : isArtists ? lang('MusicArtists') : lang('MusicAlbumsTitle', { count: lang.number(total) })}
        barTitle={lang('MusicLibrary')}
        subtitle={isArtists && total ? lang('MusicArtistsTotal', { count: lang.number(total) }) : undefined}
        isPhone={isPhone}
        tools={isPhone ? (
          <>
            {search}
            <PvSegment
              items={[
                {
                  value: 'artists',
                  label: lang('MusicSegmentCount', { name: lang('MusicArtists'), count: info.libraryArtists }),
                },
                {
                  value: 'albums',
                  label: lang('MusicSegmentCount', { name: lang('MusicAlbums'), count: info.libraryAlbums }),
                },
              ]}
              value={kind}
              label={lang('MusicLibrary')}
              isTabs
              onChange={handleKind}
            />
          </>
        ) : (
          <>
            {search}
            {sortControl}
          </>
        )}
        onBack={goBackMusic}
      />
      <div className={buildClassName(isArtists && !isPhone && styles.withPanel)}>
        <div className={styles.view}>
          {isArtists ? renderArtists() : renderAlbums()}
          {pages.hasMore && <MusicLoadMore onMore={pages.loadMore} />}
        </div>
        {isArtists && !isPhone && renderSelected()}
      </div>
    </div>
  );
};

export default memo(MusicBrowseView);
