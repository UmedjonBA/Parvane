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
  // «Найти и скачать»: сервис скачивания подключён; лимиты и расход пользователя
  isFetchEnabled: boolean;
  addPerDay: number;
  addedToday: number;
  quotaBytes: number;
  usedBytes: number;
};

// Эталон трека из каталога: с ним сервер сверяет найденные в сети файлы
export type MusicCatalogTrack = {
  artist: string;
  title: string;
  album: string;
  durationSecs: number;
  // Пометка каталога «с ненормативной лексикой»; `undefined` — каталог не знает
  isExplicit?: boolean;
  year: number;
  // Трек уже есть в библиотеке сервера
  libraryTrackId?: string;
};

export type MusicFetchCandidate = {
  id: string;
  source: string;
  title: string;
  uploader: string;
  durationSecs: number;
  // День загрузки `ГГГГ-ММ-ДД`; пусто — источник не сообщил
  uploaded: string;
  // Оценка совпадения с эталоном, 0…1000
  score: number;
  // Копия, про которую известно, что она не отредактирована
  isTrustedOriginal: boolean;
};

export type MusicFetchState = 'searching' | 'choice' | 'downloading' | 'done' | 'failed';
export type MusicFetchFailure = 'notFound' | 'source' | 'library' | 'limit';

export type MusicFetchJob = {
  jobId: string;
  state: MusicFetchState;
  track: MusicCatalogTrack;
  candidates: MusicFetchCandidate[];
  trackId?: string;
  failure?: MusicFetchFailure;
};

export type MusicAddedTrack = {
  track: MusicTrack;
  addedMs: number;
  bytes: number;
  // Ник добавившего
  adder: string;
};

export type MusicStreamQuality = 'original' | 'opus';

const PAGE = 50;
const FETCH_STATES: Record<string, MusicFetchState> = {
  FETCH_STATE_SEARCHING: 'searching',
  FETCH_STATE_NEEDS_CHOICE: 'choice',
  FETCH_STATE_DOWNLOADING: 'downloading',
  FETCH_STATE_DONE: 'done',
  FETCH_STATE_FAILED: 'failed',
};
const FETCH_FAILURES: Record<string, MusicFetchFailure> = {
  FETCH_FAILURE_NOT_FOUND: 'notFound',
  FETCH_FAILURE_SOURCE: 'source',
  FETCH_FAILURE_LIBRARY: 'library',
  FETCH_FAILURE_LIMIT: 'limit',
};
const EXPLICIT_NAMES = { yes: 'EXPLICIT_YES', no: 'EXPLICIT_NO' };
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

function toCatalogTrack(raw: Json): MusicCatalogTrack {
  const explicit = text(raw, 'explicit');
  return {
    artist: text(raw, 'artist'),
    title: text(raw, 'title'),
    album: text(raw, 'album'),
    durationSecs: count(raw, 'duration_secs'),
    isExplicit: explicit === EXPLICIT_NAMES.yes ? true : explicit === EXPLICIT_NAMES.no ? false : undefined,
    year: count(raw, 'year'),
    libraryTrackId: text(raw, 'library_track_id') || undefined,
  };
}

function fromCatalogTrack(track: MusicCatalogTrack): Json {
  return {
    artist: track.artist,
    title: track.title,
    album: track.album,
    duration_secs: track.durationSecs,
    explicit: track.isExplicit === undefined ? undefined : track.isExplicit ? EXPLICIT_NAMES.yes : EXPLICIT_NAMES.no,
    year: track.year,
  };
}

function toFetchJob(raw: Json): MusicFetchJob {
  const track = field(raw, 'track');
  return {
    jobId: text(raw, 'job_id'),
    state: FETCH_STATES[text(raw, 'state')] || 'failed',
    track: toCatalogTrack(track && typeof track === 'object' ? track as Json : {}),
    candidates: list(raw, 'candidates').map((candidate) => ({
      id: text(candidate, 'id'),
      source: text(candidate, 'source'),
      title: text(candidate, 'title'),
      uploader: text(candidate, 'uploader'),
      durationSecs: count(candidate, 'duration_secs'),
      uploaded: text(candidate, 'uploaded'),
      score: count(candidate, 'score'),
      isTrustedOriginal: Boolean(field(candidate, 'trusted_original')),
    })),
    trackId: text(raw, 'track_id') || undefined,
    failure: FETCH_FAILURES[text(raw, 'failure')],
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
          isFetchEnabled: Boolean(field(reply, 'fetch_enabled')),
          addPerDay: count(reply, 'add_per_day'),
          addedToday: count(reply, 'added_today'),
          quotaBytes: count(reply, 'quota_bytes'),
          usedBytes: count(reply, 'used_bytes'),
        };
      } catch (err) {
        deps.log(`музыка: сведения не получены: ${String(err)}`);
        return {
          isEnabled: false,
          coverBase: '',
          coverExpiresMs: 0,
          isFetchEnabled: false,
          addPerDay: 0,
          addedToday: 0,
          quotaBytes: 0,
          usedBytes: 0,
        };
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

    /** «Найти в сети»: эталоны треков из каталога по названию или исполнителю. */
    async parvaneMusicFetchCatalog({ query }: { query: string }) {
      const reply = await deps.call('music.fetch.catalog', { query });
      return list(reply, 'tracks').map(toCatalogTrack);
    },

    /** Скачать трек по эталону. Отказ — кодом протокола: `ERROR_CODE_LIMIT` (лимит), `ERROR_CODE_DUPLICATE`. */
    async parvaneMusicFetchStart({ track }: { track: MusicCatalogTrack }) {
      const reply = await deps.call('music.fetch.start', { track: fromCatalogTrack(track) });
      return toFetchJob(field(reply, 'job') as Json);
    },

    /** Продолжить задачу файлом, который выбрал пользователь. */
    async parvaneMusicFetchChoose({ jobId, candidateId }: { jobId: string; candidateId: string }) {
      const reply = await deps.call('music.fetch.start', { job_id: jobId, candidate_id: candidateId });
      return toFetchJob(field(reply, 'job') as Json);
    },

    /** Задачи скачивания пользователя: идущие и законченные за последний час. */
    async parvaneMusicFetchStatus() {
      const reply = await deps.call('music.fetch.status', {});
      return list(reply, 'jobs').map(toFetchJob);
    },

    /** Добавленное в библиотеку: своё («Загруженное») либо недавнее всех («Новое на сервере»). */
    async parvaneMusicAdded({ isMine }: { isMine: boolean }): Promise<MusicAddedTrack[]> {
      const reply = await deps.call('music.added.list', { mine: isMine, limit: PAGE });
      return list(reply, 'tracks').map((raw) => {
        const track = field(raw, 'track');
        return {
          track: toTrack(track && typeof track === 'object' ? track as Json : {}),
          addedMs: count(raw, 'added_ms'),
          bytes: count(raw, 'bytes'),
          adder: text(raw, 'adder'),
        };
      });
    },

    /** Убрать добавленный трек из библиотеки (добавивший либо администратор). */
    async parvaneMusicAddedDelete({ trackId }: { trackId: string }) {
      await deps.call('music.added.delete', { track_id: trackId });
      return true;
    },

    async parvaneMusicStarred({ offset = 0 }: { offset?: number } = {}) {
      const reply = await deps.call('music.star.list', { offset, limit: PAGE });
      return { tracks: list(reply, 'tracks').map(toTrack), hasMore: Boolean(field(reply, 'more')) };
    },
  };
}
