import { ASSET_CACHE_NAME, CUSTOM_BG_CACHE_NAME, MEDIA_CACHE_NAME } from '../../../../config';
import { yieldToMain } from '../../../../util/browser/scheduler';
import { SHARE_CACHE } from '../../../../util/shareTarget';
import { callApi } from '../../../../api/gramjs';
import { getOfflineBytes, removeOffline } from '../../../parvane/music/musicOffline';

// «Данные и память» (доска `DkSettingsB`): сколько занимает кэш по видам и очистка каждого. «Медиа из чатов» — кэши
// `tt-media*`; «Музыка для офлайна» — «Загруженное» «Музыки»; «Файлы диска на устройстве» — содержимое для просмотра,
// которое web держит только в памяти вкладки; «Прочий кэш» — остальные кэши браузера, кроме оболочки приложения
// (запуск без сети), своего фона чатов, «Поделиться» и музыки. Данные аккаунта (IndexedDB) в кэш не входят

export type CacheKind = 'media' | 'music' | 'cloud' | 'other';

export const CACHE_KINDS: CacheKind[] = ['media', 'music', 'cloud', 'other'];

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const MUSIC_CACHE_NAME = 'parvane-music-offline';
const KEPT_PREFIXES = [ASSET_CACHE_NAME, CUSTOM_BG_CACHE_NAME, SHARE_CACHE, MUSIC_CACHE_NAME];

/** Вид кэша браузера по имени; `undefined` — кэш не показывается и не чистится. */
export function getCacheKind(name: string): CacheKind | undefined {
  if (name.startsWith(MEDIA_CACHE_NAME)) return 'media';
  if (KEPT_PREFIXES.some((prefix) => name.startsWith(prefix))) return undefined;
  return 'other';
}

export async function measureCaches(): Promise<Record<CacheKind, number>> {
  const sizes: Record<CacheKind, number> = {
    media: 0,
    music: getOfflineBytes(),
    cloud: Number(await callParvane('parvaneCloudCacheBytes').catch(() => 0)) || 0,
    other: 0,
  };
  if (typeof caches === 'undefined') return sizes;
  try {
    for (const name of await caches.keys()) {
      const kind = getCacheKind(name);
      if (kind) sizes[kind] += await measureCache(name);
    }
  } catch {
    // Cache Storage недоступен — показываем то, что успели
  }
  return sizes;
}

export async function clearCache(kind: CacheKind) {
  if (kind === 'music') {
    await removeOffline();
    return;
  }
  if (kind === 'cloud') {
    await callParvane('parvaneCloudCacheClear');
    return;
  }
  if (typeof caches === 'undefined') return;
  const names = (await caches.keys()).filter((name) => getCacheKind(name) === kind);
  await Promise.all(names.map((name) => caches.delete(name)));
}

async function measureCache(name: string) {
  const cache = await caches.open(name);
  let total = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response) continue;
    const length = Number(response.headers.get('Content-Length'));
    total += length > 0 ? length : (await response.blob()).size;
    await yieldToMain();
  }
  return total;
}
