import { memo } from '../../../lib/teact/teact';

import type { MusicAlbum, MusicCatalogTrack, MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicCatalogAlbum } from '../../../api/parvane/musicCatalogApi';

import buildClassName from '../../../util/buildClassName';
import { openMusicFileSheet } from './musicFiles';
import { coverTone } from './musicFormat';
import {
  callMusic, getCurrentTrack, getMusicPlayer, playTracks, setTrackStarred,
} from './musicPlayer';
import { goBackMusic, openMusicView } from './musicView';
import useMusicData from './useMusicData';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCatalogRow from './MusicCatalogRow';
import MusicCover from './MusicCover';
import MusicTrackRow from './MusicTrackRow';

import styles from './MusicPage.module.scss';

type OwnProps = {
  // Исполнитель сервера (`id`) либо каталога (`catalogRef`)
  id?: string;
  catalogRef?: string;
  isPhone?: boolean;
  onSendToChat: (track: MusicTrack) => void;
};

type Row = { track?: MusicTrack; catalog?: MusicCatalogTrack };

type Release = {
  key: string;
  kind: 'album' | 'catalogAlbum';
  id: string;
  title: string;
  sub: string;
  coverId?: string;
  coverUrl?: string;
};

type Artist = {
  name: string;
  serverTracks: number;
  catalogTracks: number;
  isInCatalog: boolean;
  popular: Row[];
  releases: Release[];
};

const POPULAR_ROWS = 5;

// Parvane (макет «Музыки» 23 ноя, доска `XpMusic`): исполнитель — большое имя на цветном фоне, «каталог · на сервере
// 9 из 75 треков», ▶; «Популярное» — треки сервера по прослушиваниям, дальше самые слушаемые в каталоге, которых на
// сервере нет; релизы — сервера и каталога одной лентой. Исполнитель сервера ищется и в каталоге по имени
const MusicArtistPage = ({
  id, catalogRef, isPhone, onSendToChat,
}: OwnProps) => {
  const lang = useLang();
  const player = useDerivedState(getMusicPlayer);
  const current = getCurrentTrack(player);
  const { data, isFailed, reload, patch } = useMusicData<Artist>(
    `artist:${id || catalogRef}`,
    () => loadArtist(id, catalogRef),
  );

  const serverTracks = (data?.popular || []).map((row) => row.track).filter(Boolean);

  const handlePlay = useLastCallback((index: number) => {
    if (serverTracks.length) playTracks(serverTracks, index, { source: { kind: 'artist', name: data!.name } });
  });
  const handlePlayAll = useLastCallback(() => handlePlay(0));
  const handleStar = useLastCallback((track: MusicTrack) => {
    const isStarred = !track.isStarred;
    patch((previous) => ({
      ...previous,
      popular: previous.popular.map((row) => (row.track?.id === track.id ? { track: { ...track, isStarred } } : row)),
    }));
    void setTrackStarred(track, isStarred);
  });
  // «Объединить с другим написанием» (доски `ZpMusicX-04`, `ZdMusicX-03`)
  const handleMerge = useLastCallback(() => {
    if (id && data) openMusicFileSheet({ kind: 'merge', artistId: id, name: data.name });
  });
  const handleOpenRelease = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const { kind, id: releaseId } = e.currentTarget.dataset;
    openMusicView({ kind: kind as 'album', id: releaseId! });
  });

  function renderBack() {
    return (
      <button type="button" className={styles.back} aria-label={lang('Back')} data-music-back onClick={goBackMusic}>
        <ParvaneIcon name="left" />
      </button>
    );
  }

  if (!data) {
    return (
      <div className={styles.root}>
        {renderBack()}
        {isFailed ? <div role="alert">{lang('MusicLoadFailed')}</div> : <PvSkeleton onRetry={reload} />}
      </div>
    );
  }

  const tone = coverTone(id || catalogRef || data.name);
  const sub = [
    data.isInCatalog ? lang('MusicArtistCatalog') : undefined,
    data.catalogTracks > data.serverTracks
      ? lang('MusicArtistOwnedOf', { owned: data.serverTracks, total: data.catalogTracks })
      : lang('MusicTracksCount', { count: data.serverTracks }, { pluralValue: data.serverTracks }),
  ].filter(Boolean).join(' · ');
  let trackIndex = -1;

  return (
    <div className={buildClassName(styles.root, isPhone && styles.rootPhone)} data-music-artist-page>
      <div className={buildClassName(styles.hero, styles.heroArtist)} style={`--hero-tone: ${tone}`}>
        {renderBack()}
        <ParvaneIcon name="mic" className={styles.heroGlyph} />
        <div className={styles.heroText}>
          <h1 className={buildClassName(styles.title, styles.titleArtist)}>{data.name}</h1>
          <div className={styles.meta}>{sub}</div>
        </div>
      </div>
      <div className={styles.actions}>
        {id && (
          <button
            type="button"
            className={styles.action}
            aria-label={lang('MusicMergeArtistsAction')}
            data-music-artist-merge
            onClick={handleMerge}
          >
            <ParvaneIcon name="merge" />
          </button>
        )}
        <span className={styles.actionsGap} />
        <button
          type="button"
          className={styles.play}
          aria-label={lang('MusicPlay')}
          disabled={!serverTracks.length}
          data-music-play-all
          onClick={handlePlayAll}
        >
          <ParvaneIcon name="play" />
        </button>
      </div>
      {Boolean(data.popular.length) && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{lang('MusicPopular')}</h2>
          <ul className={styles.rows} data-music-tracks>
            {data.popular.map((row, position) => {
              if (row.catalog) {
                return (
                  <MusicCatalogRow
                    key={`c:${row.catalog.ref || position}`}
                    track={row.catalog}
                    rank={position + 1}
                    sub={row.catalog.album || lang('MusicInCatalogShort')}
                  />
                );
              }
              trackIndex += 1;
              const track = row.track!;
              return (
                <MusicTrackRow
                  key={`t:${track.id}`}
                  track={track}
                  index={trackIndex}
                  rank={position + 1}
                  isAlbumLine
                  isCurrent={track.id === current?.id}
                  isPlaying={player.isPlaying}
                  canQueue
                  canSaveOffline
                  onPlay={handlePlay}
                  onStar={handleStar}
                  onSendToChat={onSendToChat}
                />
              );
            })}
          </ul>
        </section>
      )}
      {Boolean(data.releases.length) && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{lang('MusicReleases')}</h2>
          <div className={styles.strip} data-music-albums>
            {data.releases.map((release) => (
              <button
                key={release.key}
                type="button"
                className={styles.tile}
                data-kind={release.kind}
                data-id={release.id}
                onClick={handleOpenRelease}
              >
                <MusicCover
                  coverId={release.coverId}
                  coverUrl={release.coverUrl}
                  toneId={release.id}
                  size={120}
                  glyph="disc"
                  className={styles.tileCover}
                />
                <span className={styles.tileTitle}>{release.title}</span>
                <span className={styles.tileSub}>{release.sub}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

/** Исполнитель сервера и каталога: сервер — его альбомы и популярное, каталог — топ и релизы, которых нет. */
async function loadArtist(id: string | undefined, catalogRef: string | undefined): Promise<Artist> {
  const server = id ? await callMusic('parvaneMusicArtist', { artistId: id }) : undefined;
  const name = server?.artist?.name || '';
  let ref = catalogRef;
  if (!ref && name) {
    const found = await callMusic('parvaneMusicCatalogSearch', { query: name }).catch(() => undefined);
    ref = found?.artists.find((artist) => artist.name.toLowerCase() === name.toLowerCase())?.ref;
  }
  const catalog = ref ? await callMusic('parvaneMusicCatalogArtist', { ref }).catch(() => undefined) : undefined;
  const serverAlbums: MusicAlbum[] = server?.albums || [];
  const serverPopular: MusicTrack[] = server?.popular || [];
  const known = new Set(serverAlbums.map((album) => album.title.toLowerCase()));
  const catalogTop = (catalog?.top || []).filter((track) => !track.libraryTrackId);
  const catalogAlbums: MusicCatalogAlbum[] = (catalog?.albums || [])
    .filter((album) => !known.has(album.title.toLowerCase()));
  return {
    name: name || catalog?.artist?.name || '',
    serverTracks: server?.artist?.trackCount || 0,
    catalogTracks: (catalog?.albums || []).reduce((sum, album) => sum + album.tracksCount, 0),
    isInCatalog: Boolean(catalog),
    popular: [
      ...serverPopular.map((track) => ({ track })),
      ...catalogTop.map((track) => ({ catalog: track })),
    ].slice(0, POPULAR_ROWS),
    releases: [
      ...serverAlbums.map((album) => ({
        key: `a:${album.id}`,
        kind: 'album' as const,
        id: album.id,
        title: album.title,
        sub: [album.year || undefined, album.isSingle ? 'single' : undefined].filter(Boolean).join(' · '),
        coverId: album.coverId,
      })),
      ...catalogAlbums.map((album) => ({
        key: `c:${album.ref}`,
        kind: 'catalogAlbum' as const,
        id: album.ref,
        title: album.title,
        sub: [album.year || undefined, album.recordType].filter(Boolean).join(' · '),
        coverUrl: album.coverUrl || undefined,
      })),
    ],
  };
}

export default memo(MusicArtistPage);
