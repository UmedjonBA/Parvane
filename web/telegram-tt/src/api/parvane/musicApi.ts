// Parvane (spec 039, 041): методы «Музыки» для экранов — общая библиотека сервера (шард `music` перед
// Navidrome). Ответы приводятся к одному виду здесь: сервер пишет поля именами схемы, большие числа — строками.
// Ошибки — кодами протокола; «Музыка не подключена на сервере» — `enabled: false`

type Json = Record<string, unknown>;

type Deps = {
  call: (method: string, request: Json) => Promise<Json>;
  log: (message: string) => void;
};

export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId: string;
  durationSecs: number;
  coverId: string;
  trackNo: number;
  year: number;
  isStarred: boolean;
};

export type MusicAlbum = {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  coverId: string;
  trackCount: number;
  durationSecs: number;
  year: number;
};

export type MusicArtist = {
  id: string;
  name: string;
  coverId: string;
  albumCount: number;
};

export type MusicInfo = {
  isEnabled: boolean;
  // База ссылок обложек: `<coverBase>/<coverId>?size=N`; пусто — обложек нет
  coverBase: string;
  coverExpiresMs: number;
};

export type MusicStreamQuality = 'original' | 'opus';

const PAGE = 50;
const QUALITY_NAMES: Record<MusicStreamQuality, string> = {
  original: 'STREAM_QUALITY_ORIGINAL',
  opus: 'STREAM_QUALITY_OPUS',
};

function field(source: Json, name: string): unknown {
  if (name in source) return source[name];
  return source[name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())];
}

const text = (source: Json, name: string) => {
  const value = field(source, name);
  return typeof value === 'string' ? value : '';
};
const count = (source: Json, name: string) => Number(field(source, name)) || 0;
const list = (source: Json, name: string) => {
  const value = field(source, name);
  return Array.isArray(value) ? value as Json[] : [];
};

function toTrack(raw: Json): MusicTrack {
  return {
    id: text(raw, 'id'),
    title: text(raw, 'title'),
    artist: text(raw, 'artist'),
    album: text(raw, 'album'),
    albumId: text(raw, 'album_id'),
    artistId: text(raw, 'artist_id'),
    durationSecs: count(raw, 'duration_secs'),
    coverId: text(raw, 'cover_id'),
    trackNo: count(raw, 'track_no'),
    year: count(raw, 'year'),
    isStarred: Boolean(field(raw, 'starred')),
  };
}

function toAlbum(raw: Json): MusicAlbum {
  return {
    id: text(raw, 'id'),
    title: text(raw, 'title'),
    artist: text(raw, 'artist'),
    artistId: text(raw, 'artist_id'),
    coverId: text(raw, 'cover_id'),
    trackCount: count(raw, 'track_count'),
    durationSecs: count(raw, 'duration_secs'),
    year: count(raw, 'year'),
  };
}

function toArtist(raw: Json): MusicArtist {
  return {
    id: text(raw, 'id'), name: text(raw, 'name'), coverId: text(raw, 'cover_id'), albumCount: count(raw, 'album_count'),
  };
}

export function createMusicApi(deps: Deps) {
  return {
    /** Подключена ли библиотека и откуда брать обложки. Отказ сервера — «не подключена». */
    async parvaneMusicInfo(): Promise<MusicInfo> {
      try {
        const reply = await deps.call('music.info', {});
        return {
          isEnabled: Boolean(field(reply, 'enabled')),
          coverBase: text(reply, 'cover_base'),
          coverExpiresMs: count(reply, 'cover_expires_ms'),
        };
      } catch (err) {
        deps.log(`музыка: сведения не получены: ${String(err)}`);
        return { isEnabled: false, coverBase: '', coverExpiresMs: 0 };
      }
    },

    /** Поиск по названию, исполнителю и альбому; пустая строка — библиотека по порядку сервера. */
    async parvaneMusicSearch({ query, offset = 0 }: { query: string; offset?: number }) {
      const reply = await deps.call('music.library.search', { query, offset, limit: PAGE });
      return {
        tracks: list(reply, 'tracks').map(toTrack),
        albums: list(reply, 'albums').map(toAlbum),
        artists: list(reply, 'artists').map(toArtist),
      };
    },

    /** Недавно добавленные альбомы. */
    async parvaneMusicRecent({ offset = 0 }: { offset?: number } = {}) {
      const reply = await deps.call('music.library.recent', { offset, limit: PAGE });
      return list(reply, 'albums').map(toAlbum);
    },

    async parvaneMusicAlbum({ albumId }: { albumId: string }) {
      const reply = await deps.call('music.library.album', { album_id: albumId });
      const album = field(reply, 'album');
      return {
        album: album && typeof album === 'object' ? toAlbum(album as Json) : undefined,
        tracks: list(reply, 'tracks').map(toTrack),
      };
    },

    async parvaneMusicArtist({ artistId }: { artistId: string }) {
      const reply = await deps.call('music.library.artist', { artist_id: artistId });
      const artist = field(reply, 'artist');
      return {
        artist: artist && typeof artist === 'object' ? toArtist(artist as Json) : undefined,
        albums: list(reply, 'albums').map(toAlbum),
      };
    },

    /** Треки по id (очередь после перезагрузки, карточки): до 100 за раз, порядок — как в запросе. */
    async parvaneMusicTracks({ trackIds }: { trackIds: string[] }) {
      if (!trackIds.length) return [];
      const reply = await deps.call('music.track.get', { track_ids: trackIds });
      const tracks = list(reply, 'tracks').map(toTrack);
      return trackIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean);
    },

    /** Ссылка на поток трека: живёт до `expiresMs`, потом берётся новая. */
    async parvaneMusicStreamUrl({ trackId, quality }: { trackId: string; quality: MusicStreamQuality }) {
      const reply = await deps.call('music.stream.url', { track_id: trackId, quality: QUALITY_NAMES[quality] });
      return { url: text(reply, 'url'), expiresMs: count(reply, 'expires_ms'), mime: text(reply, 'mime') };
    },

    async parvaneMusicStar({ trackId, isStarred }: { trackId: string; isStarred: boolean }) {
      await deps.call('music.star.set', { track_id: trackId, starred: isStarred });
      return true;
    },

    async parvaneMusicStarred({ offset = 0 }: { offset?: number } = {}) {
      const reply = await deps.call('music.star.list', { offset, limit: PAGE });
      return { tracks: list(reply, 'tracks').map(toTrack), hasMore: Boolean(field(reply, 'more')) };
    },
  };
}
