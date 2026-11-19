import type { MusicPlaylist } from '../../../api/parvane/musicApi';

import {
  getOfflineHolds, isTrackOffline, queueOfflineTracks, removeOffline, setOfflineHolds,
} from './musicOffline';
import { syncHolds } from './musicOfflineHolds';
import {
  getPlaylists, getPlaylistsStatus, loadPlaylistTracks, refreshPlaylists,
} from './musicPlaylists';

// Parvane (spec 041 C3): плейлист, загруженный на устройство, следует за составом — с этого устройства и с других
// (`parvane-music-playlists-changed`): новые треки докачиваются, убранные стираются (`musicOfflineHolds.ts`)

let isStarted = false;
let run = Promise.resolve();

/** Начать сверку (раз на вкладку): с «Музыкой» на экране и при изменении плейлистов. */
export function startOfflinePlaylistSync() {
  if (isStarted) return;
  isStarted = true;
  getPlaylists.subscribe(scheduleSync);
  getPlaylistsStatus.subscribe(scheduleSync);
  // Изменения с других устройств приходят событием, на которое подписывается чтение плейлистов
  if (Object.keys(getOfflineHolds().playlists).length) void refreshPlaylists();
}

function scheduleSync() {
  if (getPlaylistsStatus() !== 'ready') return;
  const playlists = getPlaylists();
  // По одной сверке за раз: следующая видит отметки предыдущей
  run = run.then(() => syncOffline(playlists)).catch(() => undefined);
}

async function syncOffline(playlists: MusicPlaylist[]) {
  const holds = getOfflineHolds();
  if (!Object.keys(holds.playlists).length) return;
  const current = new Map(playlists.map((playlist) => [playlist.id, playlist.items.map((item) => item.trackId)]));
  const result = syncHolds(holds, current);
  setOfflineHolds(result.holds);
  if (result.removed.length) await removeOffline(result.removed);
  const missing = result.added.filter((trackId) => !isTrackOffline(trackId));
  if (!missing.length) return;
  // Трека, которого на сервере уже нет, в ответе не будет — качать нечего
  const tracks = await loadPlaylistTracks(missing);
  queueOfflineTracks(Array.from(tracks.values()));
}
