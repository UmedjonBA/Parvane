import type { MusicAlbum, MusicCatalogTrack, MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicCatalogAlbum } from '../../../api/parvane/musicCatalogApi';

import { callMusic } from './musicPlayer';

export type MusicArtistRow = { track?: MusicTrack; catalog?: MusicCatalogTrack };

export type MusicArtistRelease = {
  key: string;
  kind: 'album' | 'catalogAlbum';
  id: string;
  title: string;
  sub: string;
  coverId?: string;
  coverUrl?: string;
};

export type MusicArtistData = {
  name: string;
  serverTracks: number;
  serverAlbums: number;
  // Альбомы каталога, которых нет на сервере
  catalogExtraAlbums: number;
  topListener?: string;
  catalogTracks: number;
  isInCatalog: boolean;
  popular: MusicArtistRow[];
  releases: MusicArtistRelease[];
};

const POPULAR_ROWS = 5;

/** Исполнитель сервера и каталога: сервер — его альбомы и популярное, каталог — топ и релизы, которых нет. */
export async function loadArtist(id: string | undefined, catalogRef: string | undefined): Promise<MusicArtistData> {
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
    serverAlbums: serverAlbums.length,
    catalogExtraAlbums: catalogAlbums.length,
    topListener: server?.topListener,
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
