import type {
  MusicAlbum, MusicArtist, MusicCatalogArtist, MusicCatalogTrack, MusicTrack,
} from '../../../api/parvane/musicApi';
import type { MusicCatalogAlbum } from '../../../api/parvane/musicCatalogApi';

// Поиск «Музыки» (доска `MusicSearch`): ответы сервера и каталога на один запрос — одним списком

export type MusicSearchFound = {
  query: string;
  server?: { tracks: MusicTrack[]; albums: MusicAlbum[]; artists: MusicArtist[] };
  catalog?: {
    tracks: MusicCatalogTrack[];
    albums: MusicCatalogAlbum[];
    artists: MusicCatalogArtist[];
    hasMore: boolean;
    nextOffset: number;
  };
  isServerFailed?: boolean;
  isCatalogFailed?: boolean;
};

export type MusicSearchArtist = {
  key: string;
  kind: 'artist' | 'catalogArtist';
  id: string;
  name: string;
  coverId?: string;
  coverUrl?: string;
  isServer: boolean;
};

export type MusicSearchAlbum = {
  key: string;
  kind: 'album' | 'catalogAlbum';
  id: string;
  title: string;
  artist: string;
  coverId?: string;
  coverUrl?: string;
};

export type MusicSearchBest = {
  kind: MusicSearchAlbum['kind'] | MusicSearchArtist['kind'];
  id: string;
  title: string;
  sub: string;
  coverId?: string;
  coverUrl?: string;
  glyph: 'disc' | 'mic';
};

/** Сервер и каталог одним списком: что уже на сервере — первым, его повтор из каталога не показывается. Лучший
 * результат — первый альбом, без альбомов — первый исполнитель. */
export function buildSearchLists(found: MusicSearchFound | undefined, withServer: boolean, withCatalog: boolean) {
  const server = withServer ? found?.server : undefined;
  const catalog = withCatalog ? found?.catalog : undefined;
  const artistNames = new Set((server?.artists || []).map((artist) => artist.name.toLowerCase()));
  const albumKeys = new Set((server?.albums || []).map((album) => albumKey(album.artist, album.title)));
  const artists: MusicSearchArtist[] = [
    ...(server?.artists || []).map((artist) => ({
      key: `a:${artist.id}`,
      kind: 'artist' as const,
      id: artist.id,
      name: artist.name,
      coverId: artist.coverId,
      isServer: true,
    })),
    ...(catalog?.artists || []).filter((artist) => !artistNames.has(artist.name.toLowerCase())).map((artist) => ({
      key: `ca:${artist.ref}`,
      kind: 'catalogArtist' as const,
      id: artist.ref,
      name: artist.name,
      coverUrl: artist.pictureUrl || undefined,
      isServer: false,
    })),
  ];
  const albums: MusicSearchAlbum[] = [
    ...(server?.albums || []).map((album) => ({
      key: `al:${album.id}`,
      kind: 'album' as const,
      id: album.id,
      title: album.title,
      artist: album.artist,
      coverId: album.coverId,
    })),
    ...(catalog?.albums || []).filter((album) => !albumKeys.has(albumKey(album.artist, album.title))).map((album) => ({
      key: `cal:${album.ref}`,
      kind: 'catalogAlbum' as const,
      id: album.ref,
      title: album.title,
      artist: album.artist,
      coverUrl: album.coverUrl || undefined,
    })),
  ];
  // Трек каталога, который уже есть на сервере, найден и поиском по серверу
  const catalogTracks = (catalog?.tracks || []).filter((track) => !track.libraryTrackId);
  const [firstAlbum] = albums;
  const [firstArtist] = artists;
  let best: MusicSearchBest | undefined;
  if (firstAlbum) {
    best = {
      kind: firstAlbum.kind,
      id: firstAlbum.id,
      title: firstAlbum.title,
      sub: firstAlbum.artist,
      coverId: firstAlbum.coverId,
      coverUrl: firstAlbum.coverUrl,
      glyph: 'disc',
    };
  } else if (firstArtist) {
    best = {
      kind: firstArtist.kind,
      id: firstArtist.id,
      title: firstArtist.name,
      sub: '',
      coverId: firstArtist.coverId,
      coverUrl: firstArtist.coverUrl,
      glyph: 'mic',
    };
  }
  return {
    artists, albums, catalogTracks, best,
  };
}

function albumKey(artist: string, title: string) {
  return `${artist}\n${title}`.toLowerCase();
}
