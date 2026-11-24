import type { MusicCatalogArtist, MusicCatalogTrack } from './musicApi';

import {
  count, field, fromCatalogTrack, list, text, toCatalogArtist, toCatalogTrack,
} from './musicApi';

// Parvane («Музыка», макет 23 ноя): каталог всей музыки (Deezer — только поиск, теги, обложки, превью) — методы
// `music.catalog.*`, история поиска `music.search.*` и тексты песен `music.lyrics` шарда music. Ответы сервер уже
// сверил с библиотекой: у трека — `libraryTrackId`, у альбома на его странице — насколько он уже на сервере

type Json = Record<string, unknown>;

type Deps = {
  call: (method: string, request: Json) => Promise<Json>;
};

export type MusicCatalogOwned = 'none' | 'partial' | 'full';

export type MusicCatalogAlbum = {
  ref: string;
  title: string;
  artist: string;
  artistRef: string;
  coverUrl: string;
  year: number;
  // album, single, ep, compile — как у каталога
  recordType: string;
  tracksCount: number;
  // Только на странице альбома
  owned?: MusicCatalogOwned;
};

export type MusicCatalogSearch = {
  artists: MusicCatalogArtist[];
  albums: MusicCatalogAlbum[];
  tracks: MusicCatalogTrack[];
  hasMore: boolean;
  nextOffset: number;
  // Треков в каталоге всего; 0 — неизвестно
  total: number;
};

export type MusicLyrics = {
  isSynced: boolean;
  lines: { startMs: number; text: string }[];
};

const OWNED_NAMES: Record<string, MusicCatalogOwned> = {
  OWNED_STATUS_NONE: 'none',
  OWNED_STATUS_PARTIAL: 'partial',
  OWNED_STATUS_FULL: 'full',
};

export function createMusicCatalogApi(deps: Deps) {
  return {
    /** Поиск по каталогу: исполнители и альбомы — только на первой странице (`offset` 0), треки — страницами. */
    async parvaneMusicCatalogSearch(
      { query, offset }: { query: string; offset?: number },
    ): Promise<MusicCatalogSearch> {
      const reply = await deps.call('music.catalog.search', { query, offset: offset || 0 });
      return {
        artists: list(reply, 'artists').map(toCatalogArtist),
        albums: list(reply, 'albums').map(toCatalogAlbum),
        tracks: list(reply, 'tracks').map(toCatalogTrack),
        hasMore: Boolean(field(reply, 'has_more')),
        nextOffset: count(reply, 'next_offset'),
        total: count(reply, 'total'),
      };
    },

    /** «Слушать из сети»: ссылка на поток трека каталога из источника; уверенного файла нет — `ERROR_CODE_NOT_FOUND`. */
    async parvaneMusicCatalogStream({ track }: { track: MusicCatalogTrack }) {
      const reply = await deps.call('music.catalog.stream', { track: fromCatalogTrack(track) });
      return { url: text(reply, 'url'), expiresMs: count(reply, 'expires_ms'), source: text(reply, 'source') };
    },

    /** «Чарт каталога» (обзор поиска): популярное в каталоге с пометкой «уже на сервере». */
    async parvaneMusicCatalogChart(): Promise<MusicCatalogTrack[]> {
      const reply = await deps.call('music.catalog.chart', {});
      return list(reply, 'tracks').map(toCatalogTrack);
    },

    /** Исполнитель каталога: альбомы, синглы и сборники, новые первыми. */
    async parvaneMusicCatalogArtist({ ref }: { ref: string }) {
      const reply = await deps.call('music.catalog.artist', { ref });
      const artist = field(reply, 'artist') as Json | undefined;
      return {
        artist: artist ? toCatalogArtist(artist) : undefined,
        albums: list(reply, 'albums').map(toCatalogAlbum),
        // «Популярное» исполнителя в каталоге
        top: list(reply, 'top').map(toCatalogTrack),
      };
    },

    /** Альбом каталога с треклистом и пометкой, насколько он уже на сервере. */
    async parvaneMusicCatalogAlbum({ ref }: { ref: string }) {
      const reply = await deps.call('music.catalog.album', { ref });
      const album = field(reply, 'album') as Json | undefined;
      return {
        album: album ? toCatalogAlbum(album) : undefined,
        tracks: list(reply, 'tracks').map(toCatalogTrack),
      };
    },

    /** История поиска — на сервере, общая для устройств аккаунта, новые первыми. */
    async parvaneMusicSearchHistory(): Promise<string[]> {
      const reply = await deps.call('music.search.history', {});
      const queries = field(reply, 'queries');
      return Array.isArray(queries) ? queries.filter((item): item is string => typeof item === 'string') : [];
    },

    async parvaneMusicSearchRemember({ query }: { query: string }) {
      await deps.call('music.search.remember', { query });
      return true;
    },

    /** Забыть запрос; без него — очистить историю поиска целиком. */
    async parvaneMusicSearchForget({ query }: { query?: string } = {}) {
      await deps.call('music.search.forget', { query: query || '' });
      return true;
    },

    /** Сколько трек играл перед сменой: сервер пишет дослушанное и пропущенное (вкус «Микса дня»). */
    async parvaneMusicListenReport({
      artist, title, listenedSecs, durationSecs,
    }: { artist: string; title: string; listenedSecs: number; durationSecs: number }) {
      await deps.call('music.listen.report', {
        artist, title, listened_secs: Math.max(0, listenedSecs), duration_secs: Math.max(0, durationSecs),
      });
      return true;
    },

    /** Текст песни: трека библиотеки по id, трека не на сервере — по исполнителю и названию (сервер ищет его сам,
     * если рядом с файлом нет). Синхронный — строки со временем начала. Не нашёлся — пусто. */
    async parvaneMusicLyrics({
      trackId, artist, title, album, durationSecs, isWrong,
    }: {
      trackId?: string; artist?: string; title?: string; album?: string; durationSecs?: number;
      // «Текст не от этой песни»: убрать и больше не подставлять
      isWrong?: boolean;
    }): Promise<MusicLyrics> {
      const reply = await deps.call('music.lyrics', {
        track_id: trackId || '',
        artist: artist || '',
        title: title || '',
        album: album || '',
        duration_secs: durationSecs || 0,
        wrong: isWrong || undefined,
      });
      return {
        isSynced: Boolean(field(reply, 'synced')),
        lines: list(reply, 'lines').map((raw) => ({ startMs: count(raw, 'start_ms'), text: text(raw, 'text') })),
      };
    },
  };
}

function toCatalogAlbum(raw: Json): MusicCatalogAlbum {
  return {
    ref: text(raw, 'ref'),
    title: text(raw, 'title'),
    artist: text(raw, 'artist'),
    artistRef: text(raw, 'artist_ref'),
    coverUrl: text(raw, 'cover_url'),
    year: count(raw, 'year'),
    recordType: text(raw, 'record_type'),
    tracksCount: count(raw, 'tracks_count'),
    owned: OWNED_NAMES[text(raw, 'owned')],
  };
}
