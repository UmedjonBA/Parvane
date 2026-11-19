import { ASSET_CACHE_NAME } from '../config';
import { pause } from '../util/schedulers';
import { hasAppShell, isAssetResponse } from './precache';

declare const self: ServiceWorkerGlobalScope;

// An attempt to fix freezing UI on iOS
const TIMEOUT = 3000;

export async function respondWithCacheNetworkFirst(e: FetchEvent) {
  const remote = await withTimeout(() => fetch(e.request), TIMEOUT);
  if (!remote?.ok) {
    return respondWithCache(e);
  }

  // Готовый набор оболочки меняет главную страницу сам, вместе со всеми её файлами (`precache.ts`): иначе без
  // сети открылась бы страница новой сборки, части которой ещё не скачаны
  if (await hasAppShell().catch(() => false)) {
    return remote;
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
    // Запуск без сети по ярлыку приложения (`/?open=…`) либо по ссылке (`/?join=…`): страница одна — из кэша
    // берётся оболочка, запрос сам разбирается при загрузке
    const cached = await cache.match(e.request, { ignoreSearch: e.request.mode === 'navigate' });

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

  if (isAssetResponse(remote) && cache) {
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
