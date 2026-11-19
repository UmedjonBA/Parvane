import type { SharedPayload } from './shareTarget';

import {
  parseSharedMeta, SHARE_CACHE, SHARE_FILE_URL, SHARE_META_URL,
} from './shareTarget';

/** Забрать полученное через «Поделиться в Parvane» (кладёт service worker); взятое из кэша удаляется. */
export async function takeSharedPayload(): Promise<SharedPayload | undefined> {
  if (typeof caches === 'undefined') return undefined;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const metaResponse = await cache.match(SHARE_META_URL);
    const meta = metaResponse ? parseSharedMeta(await metaResponse.json(), Date.now()) : undefined;
    const files = meta ? await Promise.all(meta.files.map(async (file, index) => {
      const blob = await (await cache.match(`${SHARE_FILE_URL}${index}`))?.blob();
      return blob ? new File([blob], file.name, { type: file.type || blob.type }) : undefined;
    })) : [];
    await caches.delete(SHARE_CACHE);
    if (!meta) return undefined;
    return {
      title: meta.title, text: meta.text, url: meta.url, files: files.filter((file): file is File => Boolean(file)),
    };
  } catch {
    return undefined;
  }
}
