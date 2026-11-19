// Parvane (spec 041 C3): почему трек лежит на устройстве. Трек держит загруженный плейлист либо он загружен сам
// (трек, альбом). Плейлист, загруженный на устройство, следует за своим составом: новые треки докачиваются,
// убранные стираются — если их не держит другой загруженный плейлист и они не загружены сами. Чистые функции

export type OfflineHolds = {
  // Загруженные плейлисты: состав на момент последней сверки
  playlists: Record<string, string[]>;
  // Треки, загруженные сами по себе
  direct: string[];
};

export const EMPTY_HOLDS: OfflineHolds = { playlists: {}, direct: [] };

/** Треки загружены: из плейлиста `playlistId` (весь его состав `trackIds`) либо сами по себе. */
export function addHolds(holds: OfflineHolds, trackIds: string[], playlistId?: string): OfflineHolds {
  if (playlistId) return { ...holds, playlists: { ...holds.playlists, [playlistId]: unique(trackIds) } };
  return { ...holds, direct: unique([...holds.direct, ...trackIds]) };
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
 * нет — он удалён). Итог — новые отметки, что докачать и что стереть с устройства.
 */
export function syncHolds(holds: OfflineHolds, current: Map<string, string[]>) {
  const playlists: Record<string, string[]> = {};
  const added = new Set<string>();
  const released = new Set<string>();
  Object.entries(holds.playlists).forEach(([id, before]) => {
    const now = unique(current.get(id) || []);
    const was = new Set(before);
    const stays = new Set(now);
    now.filter((trackId) => !was.has(trackId)).forEach((trackId) => added.add(trackId));
    before.filter((trackId) => !stays.has(trackId)).forEach((trackId) => released.add(trackId));
    if (current.has(id)) playlists[id] = now;
  });
  const held = new Set([...holds.direct, ...Object.values(playlists).flat()]);
  return {
    holds: { playlists, direct: holds.direct },
    added: Array.from(added),
    removed: Array.from(released).filter((trackId) => !held.has(trackId)),
  };
}

function unique(ids: string[]) {
  return Array.from(new Set(ids));
}
