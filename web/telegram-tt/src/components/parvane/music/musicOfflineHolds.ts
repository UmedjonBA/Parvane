// Parvane (spec 041 C3): почему трек лежит на устройстве. Трек держит загруженный плейлист, загруженный альбом
// либо он загружен сам. Плейлист, загруженный на устройство, следует за своим составом: новые треки докачиваются,
// убранные стираются — если их не держит другой загруженный плейлист и они не загружены сами. Чистые функции

export type OfflineHolds = {
  // Загруженные плейлисты: состав на момент последней сверки
  playlists: Record<string, string[]>;
  // Загруженные альбомы (доски `XpMusic`, `RdMusic`: «Harbor Lights · альбом»): состав на момент загрузки
  albums: Record<string, string[]>;
  // Треки, загруженные сами по себе
  direct: string[];
};

export type OfflineHolder = { kind: 'playlist' | 'album'; id: string };

export const EMPTY_HOLDS: OfflineHolds = { playlists: {}, albums: {}, direct: [] };

/** Отметки, прочитанные с устройства: записи прежних версий без альбомов. */
export function normalizeHolds(saved: Partial<OfflineHolds> | undefined): OfflineHolds {
  return { playlists: saved?.playlists || {}, albums: saved?.albums || {}, direct: saved?.direct || [] };
}

/** Треки загружены: плейлистом либо альбомом (`holder`, `trackIds` — весь состав) либо сами по себе. */
export function addHolds(holds: OfflineHolds, trackIds: string[], holder?: OfflineHolder): OfflineHolds {
  if (holder?.kind === 'playlist') {
    return { ...holds, playlists: { ...holds.playlists, [holder.id]: unique(trackIds) } };
  }
  if (holder?.kind === 'album') return { ...holds, albums: { ...holds.albums, [holder.id]: unique(trackIds) } };
  return { ...holds, direct: unique([...holds.direct, ...trackIds]) };
}

/** «Убрать» группу «Загруженного»: плейлист, альбом либо отдельные треки (`holder` не задан). Итог — новые отметки
 * и треки, которые больше ничто не держит (их стирают с устройства). */
export function releaseHolder(holds: OfflineHolds, holder: OfflineHolder | undefined, groupIds: string[]) {
  const playlists = { ...holds.playlists };
  const albums = { ...holds.albums };
  if (holder?.kind === 'playlist') delete playlists[holder.id];
  if (holder?.kind === 'album') delete albums[holder.id];
  const direct = holder ? holds.direct : holds.direct.filter((id) => !groupIds.includes(id));
  const next = { playlists, albums, direct };
  const held = new Set([...direct, ...Object.values(playlists).flat(), ...Object.values(albums).flat()]);
  // Отдельные треки — те, что не держит ни один плейлист и альбом: их стирают целиком
  const released = holder ? groupIds.filter((id) => !held.has(id)) : groupIds;
  return { holds: next, released };
}

/** Треки убраны с устройства руками (без списка — всё загруженное, плейлисты тоже забываются). Состав
 * загруженного плейлиста не меняется: убранный руками трек не докачивается снова при следующей сверке. */
export function dropHolds(holds: OfflineHolds, trackIds?: string[]): OfflineHolds {
  if (!trackIds) return EMPTY_HOLDS;
  const gone = new Set(trackIds);
  return { ...holds, direct: holds.direct.filter((trackId) => !gone.has(trackId)) };
}

/**
 * Сверка загруженных плейлистов с их нынешним составом (`current`: id плейлиста → треки по порядку; плейлиста
 * нет — он удалён). Итог — новые отметки, что докачать и что стереть с устройства. `shouldFollowNew` выключен
 * (настройка «Скачивать новое в загруженных плейлистах») — новые треки не докачиваются и в состав не входят.
 */
export function syncHolds(holds: OfflineHolds, current: Map<string, string[]>, shouldFollowNew = true) {
  const playlists: Record<string, string[]> = {};
  const added = new Set<string>();
  const released = new Set<string>();
  Object.entries(holds.playlists).forEach(([id, before]) => {
    const was = new Set(before);
    const now = unique(current.get(id) || []).filter((trackId) => shouldFollowNew || was.has(trackId));
    const stays = new Set(now);
    now.filter((trackId) => !was.has(trackId)).forEach((trackId) => added.add(trackId));
    before.filter((trackId) => !stays.has(trackId)).forEach((trackId) => released.add(trackId));
    if (current.has(id)) playlists[id] = now;
  });
  const held = new Set([...holds.direct, ...Object.values(playlists).flat(), ...Object.values(holds.albums).flat()]);
  return {
    holds: { playlists, albums: holds.albums, direct: holds.direct },
    added: Array.from(added),
    removed: Array.from(released).filter((trackId) => !held.has(trackId)),
  };
}

function unique(ids: string[]) {
  return Array.from(new Set(ids));
}
