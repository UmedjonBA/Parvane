import { ASSET_CACHE_NAME } from '../config';
import { pause } from '../util/schedulers';

declare const self: ServiceWorkerGlobalScope;

// An attempt to fix freezing UI on iOS
const TIMEOUT = 3000;

export async function respondWithCacheNetworkFirst(e: FetchEvent) {
  const remote = await withTimeout(() => fetch(e.request), TIMEOUT);
  if (!remote?.ok) {
    return respondWithCache(e);
  }

  const toCache = remote.clone();
  self.caches.open(ASSET_CACHE_NAME).then((cache) => {
    return cache?.put(e.request, toCache);
  });

  return remote;
}

export async function respondWithCache(e: FetchEvent) {
  const cacheResult = await withTimeout(async () => {
    const cache = await self.caches.open(ASSET_CACHE_NAME);
    const cached = await cache.match(e.request);

    return { cache, cached };
  }, TIMEOUT);

  const { cache, cached } = cacheResult || {};

  if (cache && cached) {
    if (cached.ok) {
      return cached;
    } else {
      await cache.delete(e.request);
    }
  }

  const remote = await fetch(e.request);

  if (remote.ok && cache) {
    cache.put(e.request, remote.clone());
  }

  return remote;
}

async function withTimeout<T>(cb: () => Promise<T>, timeout: number) {
  let isResolved = false;

  try {
    return await Promise.race([
      pause(timeout).then(() => (isResolved ? undefined : Promise.reject(new Error('TIMEOUT')))),
      cb(),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    return undefined;
  } finally {
    isResolved = true;
  }
}

export function clearAssetCache() {
  return self.caches.delete(ASSET_CACHE_NAME);
}

// Хешированные ассеты прошлых сборок живут в кэше ещё столько: открытые вкладки той сборки догружают из него
// свои ленивые куски (deploy.sh держит их на сервере один деплой — здесь запас больше)
const HASHED_ASSET_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * B3: при активации нового service worker кэш раньше стирался целиком — каждый деплой заново качал WASM и все
 * куски. Теперь удаляются только записи без хеша в имени (index.html, корень — их и так перепроверяет сеть) и
 * хешированные старше `HASHED_ASSET_MAX_AGE_MS` по заголовку `Date` ответа (без заголовка — тоже удаляются)
 */
export async function pruneAssetCache(isHashedAsset: (url: string) => boolean) {
  const cache = await self.caches.open(ASSET_CACHE_NAME);
  const requests = await cache.keys();
  const now = Date.now();
  await Promise.all(requests.map(async (request) => {
    if (isHashedAsset(request.url)) {
      const cached = await cache.match(request);
      const date = cached?.headers.get('date');
      const cachedAt = date ? Date.parse(date) : Number.NaN;
      if (cached?.ok && Number.isFinite(cachedAt) && now - cachedAt < HASHED_ASSET_MAX_AGE_MS) return;
    }
    await cache.delete(request);
  }));
}
