import type { MusicPlaylist, MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicPlaylistAction } from '../../../api/parvane/v2/musicPlaylists';

import { createSignal } from '../../../util/signals';
import { callMusic } from './musicPlayer';

// Parvane (spec 039, этап C; правило MUSIC-2): плейлисты пользователя на экране. Состояние, порядок треков и
// действия считает общая библиотека на устройстве; здесь — подписка на изменения и вызовы

export type PlaylistsStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';

const RETRY_MS = 1000;
const TRACKS_PER_REQUEST = 100;

const [getPlaylists, setPlaylists] = createSignal<MusicPlaylist[]>([]);
const [getPlaylistsStatus, setPlaylistsStatus] = createSignal<PlaylistsStatus>('loading');

export { getPlaylists, getPlaylistsStatus };

let lastView: string | undefined;
let retryTimer: number | undefined;
let isListening = false;

/** Перечитать плейлисты; пока контейнер подключается, повторять раз в секунду. */
export async function refreshPlaylists() {
  if (!isListening) {
    isListening = true;
    window.addEventListener('parvane-music-playlists-changed', () => {
      void refreshPlaylists();
    });
  }
  const reply = await callMusic('parvaneMusicPlaylists').catch(() => undefined);
  if (!reply) return;
  setPlaylistsStatus(reply.status);
  if (reply.view !== undefined && reply.view !== lastView) {
    lastView = reply.view;
    setPlaylists((JSON.parse(reply.view) as { playlists: MusicPlaylist[] }).playlists);
  }
  window.clearTimeout(retryTimer);
  if (reply.status === 'loading') {
    retryTimer = window.setTimeout(() => {
      void refreshPlaylists();
    }, RETRY_MS);
  }
}

/** Действие над плейлистами; после него экран читает новое состояние. `undefined` — не выполнено. */
export async function actOnPlaylists(action: MusicPlaylistAction) {
  const result = await callMusic('parvaneMusicPlaylistAct', { action });
  await refreshPlaylists();
  return result;
}

export function addTracksToPlaylist(playlistId: string, tracks: MusicTrack[]) {
  return actOnPlaylists({
    action: 'add',
    playlistId,
    tracks: tracks.map((track) => ({
      id: track.id, title: track.title, artist: track.artist, durationSecs: track.durationSecs,
    })),
  });
}

/** Треки плейлиста с сервера, по id: трека, которого на сервере уже нет, в ответе не будет. */
export async function loadPlaylistTracks(trackIds: string[]) {
  const byId = new Map<string, MusicTrack>();
  for (let offset = 0; offset < trackIds.length; offset += TRACKS_PER_REQUEST) {
    const page = trackIds.slice(offset, offset + TRACKS_PER_REQUEST);
    const tracks = await callMusic('parvaneMusicTracks', { trackIds: page });
    tracks.forEach((track) => byId.set(track.id, track));
  }
  return byId;
}
