import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { ApiMusicPlaylistCard } from '../../../api/types';

import {
  actOnPlaylists, getPlaylistsStatus, loadPlaylistTracks, refreshPlaylists,
} from './musicPlaylists';

// Parvane (spec 041 C4, PLAYLIST-1): плейлист из чата. Треки играют из библиотеки своего сервера — сведения о них
// перечитываются с сервера по id; трек, которого там уже нет, пропускается. «Сохранить к себе» — новый плейлист
// личного контейнера с теми же треками по порядку (повтор трека движок пропускает, MUSIC-2)

const READY_WAIT_MS = 500;
const READY_ATTEMPTS = 20;

/** Треки плейлиста из чата, которые есть в библиотеке сервера, — в порядке плейлиста. */
export async function loadSharedTracks(playlist: ApiMusicPlaylistCard): Promise<MusicTrack[]> {
  const byId = await loadPlaylistTracks(playlist.tracks.map((track) => track.trackId));
  return playlist.tracks.map((track) => byId.get(track.trackId)).filter(Boolean);
}

/** Сохранить плейлист из чата к себе; `false` — плейлисты недоступны либо запись не удалась. */
export async function saveSharedPlaylist(playlist: ApiMusicPlaylistCard) {
  if (!await waitPlaylistsReady()) return false;
  const created = await actOnPlaylists({ action: 'create', name: playlist.name });
  if (!created?.id) return false;
  const added = await actOnPlaylists({
    action: 'add',
    playlistId: created.id,
    tracks: playlist.tracks.map((track) => ({
      id: track.trackId, title: track.title, artist: track.artist, durationSecs: track.durationSecs,
    })),
  });
  return Boolean(added);
}

// Контейнер плейлистов подключается при первом обращении: до готовности действие не запишется
async function waitPlaylistsReady() {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    await refreshPlaylists();
    const status = getPlaylistsStatus();
    if (status === 'ready') return true;
    if (status !== 'loading') return false;
    await new Promise((resolve) => {
      setTimeout(resolve, READY_WAIT_MS);
    });
  }
  return false;
}
