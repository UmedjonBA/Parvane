import {
  buildSharedMeta, hasSharedContent, readShareForm, SHARE_CACHE, SHARE_FILE_URL, SHARE_META_URL,
} from '../util/shareTarget';

declare const self: ServiceWorkerGlobalScope;

// «Поделиться в Parvane» (`share_target` манифеста): POST `share/` от системы. Полученное кладётся в кэш, затем
// приложение открывается на `?open=share` — экран «Поделиться» забирает его оттуда (`util/sharedInbox.ts`)
export async function respondForShare(e: FetchEvent) {
  if (e.request.method === 'POST') {
    try {
      await saveShared(await e.request.formData());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[SHARE] Failed to save shared data', err);
    }
  }
  return Response.redirect(new URL('./?open=share', self.registration.scope).href, 303);
}

async function saveShared(form: FormData) {
  const shared = readShareForm(form);
  if (!hasSharedContent(shared)) return;
  // Прежнее непринятое заменяется: экран показывает последнее полученное
  await caches.delete(SHARE_CACHE);
  const cache = await caches.open(SHARE_CACHE);
  await Promise.all(shared.files.map((file, index) => cache.put(
    new Request(`${SHARE_FILE_URL}${index}`),
    new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } }),
  )));
  // Сведения — последними: страница читает файлы, только когда сведения уже есть
  await cache.put(new Request(SHARE_META_URL), new Response(JSON.stringify(buildSharedMeta(shared, Date.now())), {
    headers: { 'Content-Type': 'application/json' },
  }));
}
