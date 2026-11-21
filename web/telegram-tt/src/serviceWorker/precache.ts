import { ASSET_CACHE_NAME } from '../config';

declare const self: ServiceWorkerGlobalScope;

// Оболочка приложения (spec 041 F1): список файлов сборки `precache.json` (пишет vite-плагин
// `plugins/precacheManifest.ts`) кладётся в кэш целиком — без сети открывается любой модуль, а не только те,
// чьи части успели загрузиться. Главная страница и `compatTest.js` меняются в кэше только вместе с отметкой
// готового набора: без сети всегда открывается версия, все файлы которой на месте.
const PRECACHE_LIST_PATH = './precache.json';
const PRECACHE_MARKER_PATH = './__parvane-app-shell__';
const PRECACHE_MESSAGE = 'parvanePrecache';
const PRECACHE_DONE_MESSAGE = 'parvanePrecacheDone';
// Ход набора (окно «Нужно обновить приложение», доска `ZdNav`): сколько файлов уже в кэше из всех
const PRECACHE_PROGRESS_MESSAGE = 'parvanePrecacheProgress';
const PROGRESS_STEP_FILES = 20;
const PRECACHE_PARALLEL = 6;
const RE_BUILD_ID = /^[\w.-]{1,64}$/;
// Хешированные файлы прошлых сборок живут в кэше ещё столько: открытая вкладка той сборки догружает из него свои
// ленивые части (`deploy.sh` держит их на сервере одну выкладку — здесь запас больше)
const STALE_ASSET_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type AppShell = {
  build: string;
  // Пути относительно области сервис-воркера; главная страница — `./`
  files: string[];
};

let runningPrecache: Promise<string | undefined> | undefined;

type HashedAssetTest = (url: string) => boolean;
type ProgressReport = (done: number, total: number) => void;

export function handleClientMessage(e: ExtendableMessageEvent, isHashedAsset: HashedAssetTest) {
  if (e.data?.type !== PRECACHE_MESSAGE) return;
  const { source } = e;

  const reportProgress: ProgressReport = (done, total) => {
    source?.postMessage({ type: PRECACHE_PROGRESS_MESSAGE, payload: { done, total } });
  };
  e.waitUntil(precacheAppShell(isHashedAsset, reportProgress).then((build) => {
    if (build) source?.postMessage({ type: PRECACHE_DONE_MESSAGE, payload: { build } });
  }));
}

/** Готовый набор уже в кэше: главную страницу меняет только он, а не случайная загрузка с сети. */
export async function hasAppShell() {
  return Boolean(await readAppShell(await self.caches.open(ASSET_CACHE_NAME)));
}

/**
 * Чистка кэша: остаются файлы готового набора, его отметка и хешированные файлы прошлых сборок моложе
 * `STALE_ASSET_MAX_AGE_MS` (по заголовку `Date` ответа). До первого набора остаётся и всё без хеша в имени —
 * иначе смена сервис-воркера стёрла бы главную страницу, загруженную при первом визите.
 */
export async function pruneAppShellCache(isHashedAsset: HashedAssetTest) {
  const cache = await self.caches.open(ASSET_CACHE_NAME);
  const shell = await readAppShell(cache);
  const kept = new Set((shell?.files || []).map(resolveScopeUrl));
  kept.add(resolveScopeUrl(PRECACHE_MARKER_PATH));
  const now = Date.now();

  await Promise.all((await cache.keys()).map(async (request) => {
    if (kept.has(request.url)) return;
    if (isHashedAsset(request.url)) {
      const cached = await cache.match(request);
      const date = cached?.headers.get('date');
      const cachedAt = date ? Date.parse(date) : Number.NaN;
      if (cached?.ok && Number.isFinite(cachedAt) && now - cachedAt < STALE_ASSET_MAX_AGE_MS) return;
    } else if (!shell) {
      return;
    }
    await cache.delete(request);
  }));
}

function precacheAppShell(isHashedAsset: HashedAssetTest, reportProgress: ProgressReport) {
  if (!runningPrecache) {
    runningPrecache = loadAppShell(isHashedAsset, reportProgress)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[SW] App shell precache failed', err);
        return undefined;
      })
      .finally(() => {
        runningPrecache = undefined;
      });
  }
  return runningPrecache;
}

async function loadAppShell(isHashedAsset: HashedAssetTest, reportProgress: ProgressReport) {
  const listResponse = await fetch(resolveScopeUrl(PRECACHE_LIST_PATH), { cache: 'no-store' });
  if (!listResponse.ok) return undefined;
  const shell = parseAppShell(await listResponse.text());
  if (!shell) return undefined;

  const cache = await self.caches.open(ASSET_CACHE_NAME);
  if ((await readAppShell(cache))?.build === shell.build) return shell.build;

  // Файлы без хеша в имени (главная страница, `compatTest.js`) берутся свежими и ждут в памяти до конца набора
  const isHashedFile = (file: string) => isHashedAsset(resolveScopeUrl(file));
  const unhashed = shell.files.filter((file) => !isHashedFile(file));
  const fresh = await Promise.all(unhashed.map((file) => fetch(resolveScopeUrl(file), { cache: 'no-store' })));
  if (fresh.some((response) => !response.ok)) return undefined;

  const hashed = shell.files.filter(isHashedFile);
  let nextIndex = 0;
  let doneCount = 0;
  let hasFailed = false;
  reportProgress(0, hashed.length);
  await Promise.all(Array.from({ length: PRECACHE_PARALLEL }, async () => {
    while (nextIndex < hashed.length && !hasFailed) {
      const url = resolveScopeUrl(hashed[nextIndex++]);
      if (!await cache.match(url)) {
        const response = await fetch(url);
        if (!isAssetResponse(response)) {
          hasFailed = true;
          return;
        }
        await cache.put(url, response);
      }
      doneCount++;
      if (doneCount % PROGRESS_STEP_FILES === 0) reportProgress(doneCount, hashed.length);
    }
  }));
  // Выкладка посреди набора: список уже не совпадает с сервером. Следующая просьба страницы возьмёт новый
  if (hasFailed) return undefined;

  await Promise.all(unhashed.map((file, index) => cache.put(resolveScopeUrl(file), fresh[index])));
  await cache.put(resolveScopeUrl(PRECACHE_MARKER_PATH), new Response(JSON.stringify(shell)));
  await pruneAppShellCache(isHashedAsset);
  return shell.build;
}

async function readAppShell(cache: Cache) {
  const marker = await cache.match(resolveScopeUrl(PRECACHE_MARKER_PATH));
  return marker ? parseAppShell(await marker.text()) : undefined;
}

function parseAppShell(text: string): AppShell | undefined {
  try {
    const { build, files } = JSON.parse(text) as Partial<AppShell>;
    if (typeof build !== 'string' || !RE_BUILD_ID.test(build)) return undefined;
    if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) return undefined;
    return { build, files };
  } catch {
    // Вместо списка пришла страница (раздача без файла отдаёт `index.html`) — набора нет
    return undefined;
  }
}

// Раздача без настоящего 404 (предпросмотр vite) отвечает на пропавший файл главной страницей — в кэш её не класть
export function isAssetResponse(response: Response) {
  return response.ok && !response.headers.get('content-type')?.startsWith('text/html');
}

function resolveScopeUrl(path: string) {
  return new URL(path, self.registration.scope).href;
}
