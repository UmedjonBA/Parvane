// Parvane (spec 039, 041): методы «Музыки» для экранов — общая библиотека сервера (шард `music` перед
// Navidrome). Ответы приводятся к одному виду здесь: сервер пишет поля именами схемы, большие числа — строками.
// Ошибки — кодами протокола; «Музыка не подключена на сервере» — `enabled: false`

import type { MusicPlaylistAction, MusicPlaylistsSync } from './v2/musicPlaylists';

type Json = Record<string, unknown>;

type Deps = {
  call: (method: string, request: Json) => Promise<Json>;
  // Домен сервера аккаунта: его библиотеку и играет «Музыка»
  selfDomain: () => string;
  // Свой ник: «добавил я» у своих треков
  selfName: () => string;
  // Плейлисты — личный контейнер пользователя (сервер видит шифртекст)
  playlists: () => MusicPlaylistsSync;
  log: (message: string) => void;
};

export type MusicPlaylistItem = {
  // Id записи в плейлисте (не трека): один трек может стоять в разных плейлистах
  id: string;
  trackId: string;
  title: string;
  artist: string;
  durationSecs: number;
};

export type MusicPlaylist = {
  id: string;
  name: string;
  count: number;
  durationSecs: number;
  items: MusicPlaylistItem[];
};

export type MusicPlaylistsReply = {
  status: ReturnType<MusicPlaylistsSync['status']>;
  // JSON плейлистов движка — строкой: экран пропускает равные, не разбирая
  view?: string;
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
  // Макет 23 ноя: вторая и следующие версии («v2»), копия той же версии, кто добавил (ник)
  version?: number;
  isCopy?: boolean;
  adder?: string;
  // Выравнивание громкости (ReplayGain трека), дБ
  replayGainDb?: number;
  // Трек каталога, которого нет на сервере: играет отрывок 30 с («послушать до скачивания»)
  previewUrl?: string;
  coverUrl?: string;
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
  // Сингл (тип релиза у сервера): синглы исполнителя — одной плиткой (spec 041)
  isSingle: boolean;
};

export type MusicArtist = {
  id: string;
  name: string;
  coverId: string;
  albumCount: number;
  // Треков исполнителя в библиотеке; 0 — неизвестно
  trackCount: number;
};

export type MusicInfo = {
  isEnabled: boolean;
  // Домен сервера библиотеки (сервер аккаунта): карточка трека в чате играет только треки этого сервера
  server: string;
  // Свой ник (как `adder` у добавленных треков)
  selfName: string;
  // База ссылок обложек: `<coverBase>/<coverId>?size=N`; пусто — обложек нет
  coverBase: string;
  coverExpiresMs: number;
  // «Найти и скачать»: сервис скачивания подключён; лимиты и расход пользователя
  isFetchEnabled: boolean;
  // «Загрузить свои файлы» (spec 041): папка библиотеки подключена; предел одного файла
  isUploadEnabled: boolean;
  uploadMaxBytes: number;
  addPerDay: number;
  addedToday: number;
  quotaBytes: number;
  usedBytes: number;
  // Числа для экранов (spec 041): треки, исполнители и альбомы библиотеки, любимое пользователя; 0 — неизвестно
  libraryTracks: number;
  libraryArtists: number;
  libraryAlbums: number;
  starredCount: number;
  // Может удалять чужие добавленные треки
  isAdmin: boolean;
  // Сколько задач скачивания сервер ведёт разом
  fetchParallel: number;
  // Сервер не ответил: модуль показывает «Нет ответа от сервера» с «Повторить», а не «не подключена»
  isFailed?: boolean;
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
  // Запись каталога (`dz:<id>`): полные теги и обложка при скачивании
  ref?: string;
  coverUrl?: string;
  albumRef?: string;
  // Отрывок 30 с каталога
  previewUrl?: string;
};

export type MusicCatalogArtist = {
  ref: string;
  name: string;
  pictureUrl: string;
  albumsCount: number;
  // Есть в библиотеке сервера (выбор исполнителей микса)
  isOnServer?: boolean;
};

export type MusicMixMode = 'normal' | 'favorites' | 'discover';

// Строка «Микса дня»: трек библиотеки либо трек каталога (ещё не на сервере)
export type MusicMixTrack = {
  track?: MusicTrack;
  catalog?: MusicCatalogTrack;
  reason: string;
  // Каталог: похожий на какого исполнителя
  becauseOf: string;
};

export type MusicMix = {
  day: string;
  builtMs: number;
  nextMs: number;
  mode: MusicMixMode;
  tracks: MusicMixTrack[];
};

export type MusicMixSettings = {
  mode: MusicMixMode;
  hour: number;
  artists: MusicCatalogArtist[];
};

export type MusicMixToday = {
  mix?: MusicMix;
  isBuilding: boolean;
  settings: MusicMixSettings;
  needsArtists: boolean;
};

export type MusicDislike = {
  kind: 'track' | 'artist';
  trackId: string;
  ref: string;
  artist: string;
  title: string;
  createdMs: number;
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

export type MusicFetchState = 'queued' | 'searching' | 'choice' | 'downloading' | 'done' | 'failed';
export type MusicFetchFailure = 'notFound' | 'source' | 'library' | 'limit' | 'format' | 'duplicate';

export type MusicFetchJob = {
  jobId: string;
  state: MusicFetchState;
  track: MusicCatalogTrack;
  candidates: MusicFetchCandidate[];
  trackId?: string;
  failure?: MusicFetchFailure;
  // spec 041: ход загрузки (байты; 0 — сервер не знает), место в очереди сервера, причина отказа словами сервера,
  // строка запроса («Найти и скачать «запрос»»), имя своего файла (`music.upload.start`), время последней перемены
  bytesDone: number;
  bytesTotal: number;
  queueAhead: number;
  failureDetail?: string;
  query?: string;
  uploadName?: string;
  updatedMs: number;
  // Трек уже был на сервере (задача готова без скачивания): `trackId` — тот трек
  isExisting?: boolean;
  // Задача по ссылке
  url?: string;
  // Готовый трек — в «Любимое»
  isStar?: boolean;
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
  FETCH_STATE_QUEUED: 'queued',
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
  FETCH_FAILURE_FORMAT: 'format',
  FETCH_FAILURE_DUPLICATE: 'duplicate',
};
const EXPLICIT_NAMES = { yes: 'EXPLICIT_YES', no: 'EXPLICIT_NO' };
const QUALITY_NAMES: Record<MusicStreamQuality, string> = {
  original: 'STREAM_QUALITY_ORIGINAL',
  opus: 'STREAM_QUALITY_OPUS',
};

// Смещение местного времени от UTC, минуты (Москва — 180): «Микс дня» обновляется по местным суткам
function localOffsetMin() {
  return -new Date().getTimezoneOffset();
}

export function field(source: Json, name: string): unknown {
  if (name in source) return source[name];
  return source[name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())];
}

export const text = (source: Json, name: string) => {
  const value = field(source, name);
  return typeof value === 'string' ? value : '';
};
export const count = (source: Json, name: string) => Number(field(source, name)) || 0;
export const list = (source: Json, name: string) => {
  const value = field(source, name);
  return Array.isArray(value) ? value as Json[] : [];
};

export function toTrack(raw: Json): MusicTrack {
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
    version: count(raw, 'version') || undefined,
    isCopy: Boolean(field(raw, 'copy')) || undefined,
    adder: text(raw, 'adder') || undefined,
    replayGainDb: Number(field(raw, 'replay_gain_cdb')) / 100 || undefined,
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
    isSingle: Boolean(field(raw, 'single')),
  };
}

function toArtist(raw: Json): MusicArtist {
  return {
    id: text(raw, 'id'),
    name: text(raw, 'name'),
    coverId: text(raw, 'cover_id'),
    albumCount: count(raw, 'album_count'),
    trackCount: count(raw, 'track_count'),
  };
}

export function toCatalogTrack(raw: Json): MusicCatalogTrack {
  const explicit = text(raw, 'explicit');
  return {
    artist: text(raw, 'artist'),
    title: text(raw, 'title'),
    album: text(raw, 'album'),
    durationSecs: count(raw, 'duration_secs'),
    isExplicit: explicit === EXPLICIT_NAMES.yes ? true : explicit === EXPLICIT_NAMES.no ? false : undefined,
    year: count(raw, 'year'),
    libraryTrackId: text(raw, 'library_track_id') || undefined,
    ref: text(raw, 'ref') || undefined,
    coverUrl: text(raw, 'cover_url') || undefined,
    albumRef: text(raw, 'album_ref') || undefined,
    previewUrl: text(raw, 'preview_url') || undefined,
  };
}

export function toCatalogArtist(raw: Json): MusicCatalogArtist {
  return {
    ref: text(raw, 'ref'),
    name: text(raw, 'name'),
    pictureUrl: text(raw, 'picture_url'),
    albumsCount: count(raw, 'albums_count'),
    isOnServer: Boolean(field(raw, 'on_server')) || undefined,
  };
}

function toMixMode(value: string): MusicMixMode {
  return value === 'favorites' || value === 'discover' ? value : 'normal';
}

function toMixSettings(raw: Json): MusicMixSettings {
  return {
    mode: toMixMode(text(raw, 'mode')),
    hour: count(raw, 'hour'),
    artists: list(raw, 'artists').map(toCatalogArtist),
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
    ref: track.ref,
    cover_url: track.coverUrl,
    album_ref: track.albumRef,
  };
}

export function toFetchJob(raw: Json): MusicFetchJob {
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
    bytesDone: count(raw, 'bytes_done'),
    bytesTotal: count(raw, 'bytes_total'),
    queueAhead: count(raw, 'queue_ahead'),
    failureDetail: text(raw, 'failure_detail') || undefined,
    query: text(raw, 'query') || undefined,
    uploadName: text(raw, 'upload_name') || undefined,
    updatedMs: count(raw, 'updated_ms'),
    isExisting: Boolean(field(raw, 'existing')) || undefined,
    url: text(raw, 'url') || undefined,
    isStar: Boolean(field(raw, 'star')) || undefined,
  };
}

export function createMusicApi(deps: Deps) {
  // Подключение контейнера плейлистов — один раз за сессию страницы; дальше синк идёт по таймеру модуля
  let isPlaylistsStarted = false;
  // Действия над плейлистами — строго по одному: следующее считается от состояния после предыдущего
  let playlistChain: Promise<unknown> = Promise.resolve();

  async function actOnPlaylists(action: MusicPlaylistAction) {
    const playlists = deps.playlists();
    const composed = playlists.compose(action, Date.now());
    if (!composed) return undefined;
    if (composed.changes.length) {
      playlists.apply(composed.changes);
      await playlists.flush();
    }
    return { id: composed.id, skipped: composed.skipped || 0, changed: composed.changes.length };
  }

  return {
    /** Подключена ли библиотека и откуда брать обложки. Отказ сервера — «не подключена». */
    async parvaneMusicInfo(): Promise<MusicInfo> {
      try {
        const reply = await deps.call('music.info', {});
        return {
          isEnabled: Boolean(field(reply, 'enabled')),
          server: deps.selfDomain(),
          selfName: deps.selfName(),
          coverBase: text(reply, 'cover_base'),
          coverExpiresMs: count(reply, 'cover_expires_ms'),
          isFetchEnabled: Boolean(field(reply, 'fetch_enabled')),
          isUploadEnabled: Boolean(field(reply, 'upload_enabled')),
          uploadMaxBytes: count(reply, 'upload_max_bytes'),
          addPerDay: count(reply, 'add_per_day'),
          addedToday: count(reply, 'added_today'),
          quotaBytes: count(reply, 'quota_bytes'),
          usedBytes: count(reply, 'used_bytes'),
          libraryTracks: count(reply, 'library_tracks'),
          libraryArtists: count(reply, 'library_artists'),
          libraryAlbums: count(reply, 'library_albums'),
          starredCount: count(reply, 'starred_count'),
          isAdmin: Boolean(field(reply, 'admin')),
          fetchParallel: count(reply, 'fetch_parallel'),
        };
      } catch (err) {
        deps.log(`музыка: сведения не получены: ${String(err)}`);
        return {
          isEnabled: false,
          isFailed: true,
          server: deps.selfDomain(),
          selfName: deps.selfName(),
          coverBase: '',
          coverExpiresMs: 0,
          isFetchEnabled: false,
          isUploadEnabled: false,
          uploadMaxBytes: 0,
          addPerDay: 0,
          addedToday: 0,
          quotaBytes: 0,
          usedBytes: 0,
          libraryTracks: 0,
          libraryArtists: 0,
          libraryAlbums: 0,
          starredCount: 0,
          isAdmin: false,
          fetchParallel: 0,
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

    /** «Главная» (доска `MusicHome`): популярное за неделю с числом прослушиваний, частые исполнители, новые альбомы. */
    async parvaneMusicHome() {
      const reply = await deps.call('music.library.home', {});
      return {
        popular: list(reply, 'popular').flatMap((raw) => {
          const track = field(raw, 'track') as Json | undefined;
          return track ? [{ track: toTrack(track), playsWeek: count(raw, 'plays_week') }] : [];
        }),
        frequentArtists: list(reply, 'frequent_artists').map(toArtist),
        fresh: list(reply, 'fresh').map(toAlbum),
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
        // «Популярное на сервере»: по прослушиваниям всех пользователей
        popular: list(reply, 'popular').map(toTrack),
        // «Чаще всех слушает …» за 30 дней (ник)
        topListener: text(reply, 'top_listener') || undefined,
      };
    },

    /** Треки по id (очередь после перезагрузки, карточки): до 100 за раз, порядок — как в запросе. */
    async parvaneMusicTracks({ trackIds }: { trackIds: string[] }) {
      if (!trackIds.length) return [];
      const reply = await deps.call('music.track.get', { track_ids: trackIds });
      const tracks = list(reply, 'tracks').map(toTrack);
      return trackIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean);
    },

    /** Ссылка на поток трека: живёт до `expiresMs`, потом берётся новая. `isDownload` — загрузка на устройство
     * (в «Популярное на сервере» не считается). */
    async parvaneMusicStreamUrl({ trackId, quality, isDownload }: {
      trackId: string; quality: MusicStreamQuality; isDownload?: boolean;
    }) {
      const reply = await deps.call('music.stream.url', {
        track_id: trackId, quality: QUALITY_NAMES[quality], download: isDownload || undefined,
      });
      return { url: text(reply, 'url'), expiresMs: count(reply, 'expires_ms'), mime: text(reply, 'mime') };
    },

    async parvaneMusicStar({ trackId, isStarred }: { trackId: string; isStarred: boolean }) {
      await deps.call('music.star.set', { track_id: trackId, starred: isStarred });
      return true;
    },

    /** Плейлисты пользователя: состояние контейнера и показ движка. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneMusicPlaylists(): Promise<MusicPlaylistsReply> {
      try {
        const playlists = deps.playlists();
        const status = playlists.status();
        if (status !== 'needs-linking' && status !== 'loading' && !isPlaylistsStarted) {
          isPlaylistsStarted = true;
          void playlists.ensure();
        }
        return { status, view: playlists.viewJson() };
      } catch (err) {
        deps.log(`музыка: плейлисты не прочитаны: ${String(err)}`);
        return { status: 'offline' };
      }
    },

    /** Действие над плейлистами (создать, переименовать, удалить, добавить треки, убрать, переставить):
     * изменения считает движок. Ответ — id нового плейлиста, число пропущенных повторов; `undefined` — не удалось. */
    parvaneMusicPlaylistAct({ action }: { action: MusicPlaylistAction }) {
      const run = playlistChain.then(() => actOnPlaylists(action)).catch((err: unknown) => {
        deps.log(`музыка: действие над плейлистом не выполнено: ${String(err)}`);
        return undefined;
      });
      playlistChain = run;
      return run;
    },

    /** Есть ли у плейлистов зрители: без них опрос сервера редкий. */
    // eslint-disable-next-line @typescript-eslint/require-await
    async parvaneMusicPlaylistsSetActive({ isActive }: { isActive: boolean }) {
      deps.playlists().setActive(isActive);
      return true;
    },

    /** «Микс дня» на сегодня (по местному времени): готовый, собирается либо нужны любимые исполнители. */
    async parvaneMusicMixToday(): Promise<MusicMixToday> {
      const reply = await deps.call('music.mix.today', { tz_offset_min: localOffsetMin() });
      const mix = field(reply, 'mix') as Json | undefined;
      return {
        mix: mix ? {
          day: text(mix, 'day'),
          builtMs: count(mix, 'built_ms'),
          nextMs: count(mix, 'next_ms'),
          mode: toMixMode(text(mix, 'mode')),
          tracks: list(mix, 'tracks').map((row) => {
            const track = field(row, 'track') as Json | undefined;
            const catalog = field(row, 'catalog') as Json | undefined;
            return {
              track: track ? toTrack(track) : undefined,
              catalog: catalog ? toCatalogTrack(catalog) : undefined,
              reason: text(row, 'reason'),
              becauseOf: text(row, 'because_of'),
            };
          }),
        } : undefined,
        isBuilding: Boolean(field(reply, 'building')),
        settings: toMixSettings((field(reply, 'settings') as Json | undefined) || {}),
        needsArtists: Boolean(field(reply, 'needs_artists')),
      };
    },

    /** Настройки микса: режим, час обновления, любимые исполнители (`undefined` — не менять). */
    async parvaneMusicMixSettings({ mode, hour, artists }: {
      mode?: MusicMixMode; hour?: number; artists?: MusicCatalogArtist[];
    }) {
      const reply = await deps.call('music.mix.settings', {
        mode: mode || '',
        set_hour: hour !== undefined,
        hour: hour ?? 0,
        set_artists: artists !== undefined,
        artists: (artists || []).map((artist) => ({
          ref: artist.ref, name: artist.name, picture_url: artist.pictureUrl, albums_count: artist.albumsCount,
        })),
        tz_offset_min: localOffsetMin(),
      });
      return toMixSettings((field(reply, 'settings') as Json | undefined) || {});
    },

    /** «Другой микс»: собрать заново. */
    async parvaneMusicMixRebuild() {
      await deps.call('music.mix.rebuild', { tz_offset_min: localOffsetMin() });
    },

    /** Исполнители для выбора: пусто — подсказки, иначе — поиск по каталогу. */
    async parvaneMusicMixArtists({ query }: { query: string }) {
      const reply = await deps.call('music.mix.artists', { query });
      return list(reply, 'artists').map(toCatalogArtist);
    },

    /** «Не нравится» на трек (библиотеки — `trackId`, каталога — `ref`) либо исполнителя; `isUndo` — снять. */
    async parvaneMusicDislike({
      trackId, ref, artist, title, isUndo,
    }: { trackId?: string; ref?: string; artist?: string; title?: string; isUndo?: boolean }) {
      await deps.call('music.dislike.set', {
        track_id: trackId || '', ref: ref || '', artist: artist || '', title: title || '', undo: Boolean(isUndo),
      });
    },

    async parvaneMusicDislikes(): Promise<MusicDislike[]> {
      const reply = await deps.call('music.dislike.list', {});
      return list(reply, 'items').map((raw) => ({
        kind: text(raw, 'kind') === 'artist' ? 'artist' as const : 'track' as const,
        trackId: text(raw, 'track_id'),
        ref: text(raw, 'ref'),
        artist: text(raw, 'artist'),
        title: text(raw, 'title'),
        createdMs: count(raw, 'created_ms'),
      }));
    },

    /** «Найти в сети»: эталоны треков из каталога по названию или исполнителю. */
    async parvaneMusicFetchCatalog({ query }: { query: string }) {
      const reply = await deps.call('music.fetch.catalog', { query });
      return list(reply, 'tracks').map(toCatalogTrack);
    },

    /** Скачать трек по эталону. Отказ — кодом протокола: `ERROR_CODE_LIMIT` (лимит), `ERROR_CODE_DUPLICATE`. */
    async parvaneMusicFetchStart({ track, isStar }: { track: MusicCatalogTrack; isStar?: boolean }) {
      // `star` — готовый трек сервер сам кладёт в «Любимое» добавившего
      const reply = await deps.call('music.fetch.start', { track: fromCatalogTrack(track), star: isStar || undefined });
      return toFetchJob(field(reply, 'job') as Json);
    },

    /** Добавить на сервер альбом каталога целиком: задачи на треки, которых на сервере ещё нет. */
    async parvaneMusicFetchAlbum({ albumRef }: { albumRef: string }) {
      const reply = await deps.call('music.fetch.start', { album_ref: albumRef });
      return list(reply, 'jobs').map(toFetchJob);
    },

    /** «Найти и скачать «запрос»»: эталон сервер берёт из каталога сам (spec 041). */
    async parvaneMusicFetchQuery({ query }: { query: string }) {
      const reply = await deps.call('music.fetch.start', { query });
      return toFetchJob(field(reply, 'job') as Json);
    },

    /** Снять задачу: идущая останавливается, законченная убирается из «Загрузок на сервер». */
    async parvaneMusicFetchCancel({ jobId }: { jobId: string }) {
      await deps.call('music.fetch.cancel', { job_id: jobId });
      return true;
    },

    /** «Добавить первым»: своя ждущая задача — перед своими же ждущими. */
    async parvaneMusicFetchFirst({ jobId }: { jobId: string }) {
      const reply = await deps.call('music.fetch.first', { job_id: jobId });
      const job = field(reply, 'job');
      return job && typeof job === 'object' ? toFetchJob(job as Json) : undefined;
    },

    /** Свой файл: задача и ссылка для `PUT` байтов (без ссылки — такой файл уже в библиотеке). */
    async parvaneMusicUploadStart({
      fileName, bytes, sha256, title, artist, durationSecs,
    }: {
      fileName: string; bytes: number; sha256: string; title: string; artist: string; durationSecs: number;
    }) {
      const reply = await deps.call('music.upload.start', {
        file_name: fileName, bytes, sha256, title, artist, duration_secs: durationSecs,
      });
      return {
        job: toFetchJob(field(reply, 'job') as Json), url: text(reply, 'url'), expiresMs: count(reply, 'expires_ms'),
      };
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
