// Обложки «Музыки» (`/_parvane/music/c/<подпись>/<обложка>?size=N`): подпись выдаётся заново при каждом запуске, и
// без своего кэша браузер качал все обложки снова. Ключ — обложка и размер без подписи; сначала кэш, потом сеть
const COVER_PATH = /\/_parvane\/music\/c\/[^/]+\/(.+)$/;
const CACHE_NAME = 'parvane-music-covers-v1';
// Больше — самые старые записи уходят (по порядку добавления в кэш)
const MAX_ENTRIES = 3000;
const PRUNE_BATCH = 300;

export function isMusicCover(pathname: string) {
  return COVER_PATH.test(pathname);
}

export async function respondForMusicCover(e: FetchEvent) {
  const url = new URL(e.request.url);
  const coverId = url.pathname.match(COVER_PATH)![1];
  const key = `${url.origin}/_parvane/music/cover/${coverId}${url.search}`;
  const cache = await self.caches.open(CACHE_NAME);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(e.request);
  if (response.ok && response.headers.get('Content-Type')?.startsWith('image/')) {
    e.waitUntil(cache.put(key, response.clone()).then(() => pruneCovers(cache)));
  }
  return response;
}

async function pruneCovers(cache: Cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  await Promise.all(keys.slice(0, PRUNE_BATCH).map((request) => cache.delete(request)));
}
