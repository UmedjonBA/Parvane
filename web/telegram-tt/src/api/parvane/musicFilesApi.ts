import type { MusicTrack } from './musicApi';

import {
  count, field, list, text, toFetchJob, toTrack,
} from './musicApi';

// Parvane (макет «Музыки» 23 ноя): файлы библиотеки — «Откуда файл», правка тегов, корзина, «Вставить ссылку» и
// вторая версия (`music.file.*`, `music.trash.*`, `music.fetch.start` с `url`). Права проверяет сервер: своё —
// добавивший, чужое — администратор

type Json = Record<string, unknown>;

type Deps = {
  call: (method: string, request: Json) => Promise<Json>;
};

export type MusicTagField = 'title' | 'artist' | 'album' | 'album_artist' | 'year' | 'genre' | 'track_no'
  | 'release_type';

export type MusicTags = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  year: number;
  genre: string;
  trackNo: number;
  // album, single, ep, compilation
  releaseType: string;
};

export type MusicFileInfo = {
  source: string;
  sourceRef: string;
  adder: string;
  addedMs: number;
  codec: string;
  bitrateKbps: number;
  sampleRate: number;
  bits: number;
  bytes: number;
  path: string;
  tags: MusicTags;
  editedMs: number;
  editedBy: string;
  hasOriginalTags: boolean;
  versions: MusicTrack[];
  canEdit: boolean;
  hasCover: boolean;
};

export type MusicTrashItem = {
  id: string;
  title: string;
  artist: string;
  adder: string;
  deletedBy: string;
  deletedMs: number;
  daysLeft: number;
  version: number;
};

function toTags(raw: Json): MusicTags {
  return {
    title: text(raw, 'title'),
    artist: text(raw, 'artist'),
    album: text(raw, 'album'),
    albumArtist: text(raw, 'album_artist'),
    year: count(raw, 'year'),
    genre: text(raw, 'genre'),
    trackNo: count(raw, 'track_no'),
    releaseType: text(raw, 'release_type'),
  };
}

export function createMusicFilesApi(deps: Deps) {
  return {
    async parvaneMusicFileInfo({ trackId }: { trackId: string }): Promise<MusicFileInfo> {
      const raw = await deps.call('music.file.info', { track_id: trackId });
      const tags = field(raw, 'tags');
      return {
        source: text(raw, 'source'),
        sourceRef: text(raw, 'source_ref'),
        adder: text(raw, 'adder'),
        addedMs: count(raw, 'added_ms'),
        codec: text(raw, 'codec'),
        bitrateKbps: count(raw, 'bitrate_kbps'),
        sampleRate: count(raw, 'sample_rate'),
        bits: count(raw, 'bits'),
        bytes: count(raw, 'bytes'),
        path: text(raw, 'path'),
        tags: toTags(tags && typeof tags === 'object' ? tags as Json : {}),
        editedMs: count(raw, 'edited_ms'),
        editedBy: text(raw, 'edited_by'),
        hasOriginalTags: Boolean(field(raw, 'has_original_tags')),
        versions: list(raw, 'versions').map(toTrack),
        canEdit: Boolean(field(raw, 'can_edit')),
        hasCover: Boolean(field(raw, 'has_cover')),
      };
    },

    /** Переписать поля `fields` у всех треков разом; обложка — ссылкой каталога либо картинкой. */
    async parvaneMusicFileTags({
      trackIds, tags, fields, coverUrl, cover,
    }: {
      trackIds: string[]; tags: Partial<MusicTags>; fields: MusicTagField[]; coverUrl?: string; cover?: Uint8Array;
    }) {
      const reply = await deps.call('music.file.tags', {
        track_ids: trackIds,
        tags: {
          title: tags.title || '',
          artist: tags.artist || '',
          album: tags.album || '',
          album_artist: tags.albumArtist || '',
          year: tags.year || 0,
          genre: tags.genre || '',
          track_no: tags.trackNo || 0,
          release_type: tags.releaseType || '',
        },
        fields,
        cover_url: coverUrl || '',
        cover: cover || new Uint8Array(),
      });
      return { changed: count(reply, 'changed'), failed: count(reply, 'failed') };
    },

    async parvaneMusicFileRestoreTags({ trackId }: { trackId: string }) {
      await deps.call('music.file.restore_tags', { track_id: trackId });
      return true;
    },

    async parvaneMusicTrashList(): Promise<{ items: MusicTrashItem[]; isAdmin: boolean }> {
      const reply = await deps.call('music.trash.list', {});
      return {
        items: list(reply, 'items').map((raw) => ({
          id: text(raw, 'id'),
          title: text(raw, 'title'),
          artist: text(raw, 'artist'),
          adder: text(raw, 'adder'),
          deletedBy: text(raw, 'deleted_by'),
          deletedMs: count(raw, 'deleted_ms'),
          daysLeft: count(raw, 'days_left'),
          version: count(raw, 'version'),
        })),
        isAdmin: Boolean(field(reply, 'admin')),
      };
    },

    async parvaneMusicTrashRestore({ id }: { id: string }) {
      await deps.call('music.trash.restore', { id });
      return true;
    },

    /** Стереть навсегда раньше срока (администратор); `isAll` — очистить корзину. */
    async parvaneMusicTrashPurge({ id, isAll }: { id?: string; isAll?: boolean }) {
      await deps.call('music.trash.purge', { id: id || '', all: Boolean(isAll) });
      return true;
    },

    /** «Вставить ссылку» (YouTube, SoundCloud, Bandcamp); `asVersion` — вторая версия трека, что уже на сервере. */
    async parvaneMusicFetchLink({ url, asVersion, isStar }: { url: string; asVersion?: boolean; isStar?: boolean }) {
      const reply = await deps.call('music.fetch.start', {
        url, as_version: Boolean(asVersion), star: Boolean(isStar),
      });
      return toFetchJob(field(reply, 'job') as Json);
    },
  };
}
