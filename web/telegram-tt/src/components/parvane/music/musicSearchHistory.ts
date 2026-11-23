import { callMusic } from './musicPlayer';
import { getMusicQuery } from './musicView';

const MIN_QUERY_LENGTH = 2;

/** «Недавние запросы» (на сервере): запрос, по которому что-то сделали — Enter, открыли, включили, добавили. */
export function rememberMusicQuery(query = getMusicQuery().trim()) {
  if (query.length < MIN_QUERY_LENGTH) return;
  void callMusic('parvaneMusicSearchRemember', { query }).catch(() => undefined);
}

// «Недавнее» (доска `MusicSearch-01`): открытое из поиска — исполнитель, альбом, трек, плейлист — хранится в той же
// истории сервера строкой JSON; набранный запрос (Enter) — как есть
const ITEM_MARK = '{"k":';
const TEXT_MAX = 80;

export type MusicRecentItem = {
  kind: 'artist' | 'album' | 'track' | 'playlist' | 'shared' | 'catalogArtist' | 'catalogAlbum';
  id: string;
  title: string;
  sub?: string;
};

export function rememberMusicItem(item: MusicRecentItem) {
  const entry = JSON.stringify({
    k: item.kind, i: item.id, t: item.title.slice(0, TEXT_MAX), s: item.sub?.slice(0, TEXT_MAX),
  });
  void callMusic('parvaneMusicSearchRemember', { query: entry }).catch(() => undefined);
}

/** Строка истории → открытое (`item`) либо набранный запрос (`query`). */
export function parseRecent(entry: string): { item?: MusicRecentItem; query?: string } {
  if (!entry.startsWith(ITEM_MARK)) return { query: entry };
  try {
    const raw = JSON.parse(entry) as { k: MusicRecentItem['kind']; i: string; t: string; s?: string };
    return { item: { kind: raw.k, id: raw.i, title: raw.t, sub: raw.s } };
  } catch (err) {
    return { query: entry };
  }
}
