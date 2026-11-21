import type { MusicAlbum, MusicArtist, MusicTrack } from '../../../api/parvane/musicApi';

import { engineStatic } from '../../../api/parvane/v2/engine';

// Parvane (spec 041, правило MUSIC-4): списки библиотеки «Музыки» на экранах — порядок, группы по букве, отбор по
// строке, склейка страниц, найденное одним списком, «Загруженное» группами. Правила считает движок
// (`music_library.rs`), здесь — только вызовы

export type MusicArtistSort = 'name' | 'tracks';
export type MusicAlbumSort = 'artist' | 'new';
export type MusicSearchFilter = 'all' | 'tracks' | 'artists' | 'albums';
export type MusicSearchRow = { kind: 'track' | 'album' | 'artist'; id: string };
export type MusicLetterGroup = { letter: string; ids: string[] };
export type MusicOfflineGroup = {
  kind: 'playlist' | 'album' | 'tracks';
  id: string;
  trackIds: string[];
  bytes: number;
};

export function sortArtists(artists: MusicArtist[], by: MusicArtistSort) {
  return engineStatic<MusicArtist[]>('musicLibrarySort', { kind: 'artists', by, items: artists });
}

/** Альбомы по исполнителю; «Новые» — порядок сервера (`music.library.recent`), его не трогаем. */
export function sortAlbums(albums: MusicAlbum[]) {
  return engineStatic<MusicAlbum[]>('musicLibrarySort', { kind: 'albums', by: 'artist', items: albums });
}

export function sortTracksByArtist(tracks: MusicTrack[]) {
  return engineStatic<MusicTrack[]>('musicLibrarySort', { kind: 'tracks', by: 'artist', items: tracks });
}

export function groupByLetter(items: { id: string; name: string }[]) {
  return engineStatic<MusicLetterGroup[]>('musicLibraryGroups', { items });
}

/** Каждое слово строки есть в одном из полей (как поиск сервера); пустая строка — всё. */
export function filterByQuery<T extends { id: string }>(items: T[], query: string, fields: (keyof T & string)[]) {
  return engineStatic<T[]>('musicLibraryFilter', { items, query, fields });
}

/** Следующая страница к показанному без повторов. */
export function mergePage<T extends { id: string }>(items: T[], page: T[]) {
  return engineStatic<T[]>('musicPageMerge', { items, page });
}

export function buildSearchRows(
  found: { tracks: MusicTrack[]; albums: MusicAlbum[]; artists: MusicArtist[] }, filter: MusicSearchFilter,
) {
  return engineStatic<MusicSearchRow[]>('musicSearchRows', { ...found, filter });
}

export function groupOffline(
  entries: { id: string; bytes: number }[],
  holds: { playlists: Record<string, string[]>; albums: Record<string, string[]> },
  playlistOrder: string[],
) {
  return engineStatic<MusicOfflineGroup[]>('musicOfflineGroups', { entries, holds, playlistOrder });
}
