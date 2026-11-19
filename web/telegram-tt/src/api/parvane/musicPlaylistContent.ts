import type { WireMessageContent, WirePlaylistTrack } from './wire';

// Parvane (spec 041 C4, PLAYLIST-1): содержимое сообщения «плейлист в чат». Пределы схемы `MusicPlaylistShare`
// считаются в байтах UTF-8: подписи урезаются по байтам, а треки берутся по порядку, пока сообщение умещается
// в операцию (полезная нагрузка — до 256 КиБ вместе с подписью и конвертом)

const NAME_MAX_BYTES = 240;
const SERVER_MAX_BYTES = 253;
const TRACK_ID_MAX_BYTES = 128;
const LABEL_MAX_BYTES = 400;
const TEXT_MAX_BYTES = 600;
const TRACKS_MAX = 500;
const TRACKS_BUDGET_BYTES = 180 * 1024;
// Треков в `text` для клиентов без «Музыки»
const TEXT_TRACKS = 3;
// Поля трека в схеме: номера и длины полей, длительность
const TRACK_OVERHEAD_BYTES = 16;

const encoder = new TextEncoder();

export type PlaylistShareTrack = {
  id: string;
  title: string;
  artist: string;
  durationSecs: number;
};

export function buildMusicPlaylistContent(playlist: {
  name: string; server: string; tracks: PlaylistShareTrack[];
}): WireMessageContent {
  const name = cutToBytes(playlist.name.trim(), NAME_MAX_BYTES);
  const tracks: WirePlaylistTrack[] = [];
  let budget = TRACKS_BUDGET_BYTES;
  for (const track of playlist.tracks) {
    if (tracks.length >= TRACKS_MAX) break;
    if (!track.id || encoder.encode(track.id).length > TRACK_ID_MAX_BYTES) continue;
    const item = {
      track_id: track.id,
      title: cutToBytes(track.title, LABEL_MAX_BYTES),
      artist: cutToBytes(track.artist, LABEL_MAX_BYTES) || undefined,
      duration_secs: track.durationSecs || undefined,
    };
    budget -= encoder.encode(`${item.track_id}${item.title}${item.artist || ''}`).length + TRACK_OVERHEAD_BYTES;
    if (budget < 0) break;
    tracks.push(item);
  }
  return {
    kind: 'music_playlist',
    name,
    track_server: cutToBytes(playlist.server, SERVER_MAX_BYTES),
    playlist_tracks: tracks,
    text: cutToBytes(buildText(name, tracks), TEXT_MAX_BYTES),
  };
}

// «🎵 Для работы: Lampa — Ночной автобус, …» — для клиентов без «Музыки»
function buildText(name: string, tracks: WirePlaylistTrack[]) {
  const first = tracks.slice(0, TEXT_TRACKS).map((track) => [track.artist, track.title].filter(Boolean).join(' — '));
  const more = tracks.length > TEXT_TRACKS ? ', …' : '';
  return first.length ? `🎵 ${name}: ${first.join(', ')}${more}` : `🎵 ${name}`;
}

function cutToBytes(text: string, maxBytes: number) {
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = '';
  let size = 0;
  for (const char of text) {
    size += encoder.encode(char).length;
    if (size > maxBytes) break;
    out += char;
  }
  return out;
}
