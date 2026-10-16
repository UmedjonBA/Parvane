import { DEBUG } from '../config';
import { pause } from '../util/schedulers';
import { pruneAssetCache, respondWithCache, respondWithCacheNetworkFirst } from './assetCache';
import { respondForDownload } from './download';
import { respondForProgressive } from './progressive';
import {
  handleClientMessage as handleNotificationMessage,
  handleNotificationClick,
  handlePush,
} from './pushNotification';
import { handleClientMessage as handleShareMessage, respondForShare } from './share';

declare const self: ServiceWorkerGlobalScope;

const CACHE_FIRST_ASSET_EXTENSIONS = 'js|css|woff2?|svg|png|jpe?g|tgs|json|wasm';
// B3: WASM (движок протокола 2,7 МБ) больше не «сначала сеть» — имя файла с хешем, он в кэше навсегда,
// как и остальные хешированные ассеты; «сначала сеть» остаётся для HTML и `compatTest.js` (без хеша в имени;
// без него приложение не запускается — без сети раньше оставался белый экран)
const RE_NETWORK_FIRST_ASSETS = /(?:\.html|\/compatTest\.js)$/;
const RE_CACHE_FIRST_ASSETS = new RegExp(
  `(?:/assets/[^/]+|/(?:[^/]+\\.)?worker|/index)-[\\w-]{8}`
  + `\\.(${CACHE_FIRST_ASSET_EXTENSIONS})$`,
);
const ACTIVATE_TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('ServiceWorker installed');
  }

  // Activate worker immediately
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (e) => {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('ServiceWorker activated');
  }

  e.waitUntil(
    Promise.race([
      // An attempt to fix freezing UI on iOS
      pause(ACTIVATE_TIMEOUT),
      Promise.all([
        // B3: не стирать кэш целиком при каждой смене service worker (= каждый деплой), а убрать устаревшее
        pruneAssetCache((url) => RE_CACHE_FIRST_ASSETS.test(new URL(url).pathname)),
        // Become available to all pages
        self.clients.claim(),
      ]),
    ]),
  );
});

self.addEventListener('fetch', (e: FetchEvent) => {
  const { url } = e.request;
  const { scope } = self.registration;
  if (!url.startsWith(scope)) {
    return false;
  }

  const { pathname, protocol } = new URL(url);
  const { pathname: scopePathname } = new URL(scope);

  if (pathname.includes('/progressive/')) {
    e.respondWith(respondForProgressive(e));
    return true;
  }

  if (pathname.includes('/download/')) {
    e.respondWith(respondForDownload(e));
    return true;
  }

  if (pathname.includes('/share/')) {
    e.respondWith(respondForShare(e));
  }

  if (protocol === 'http:' || protocol === 'https:') {
    if (pathname === scopePathname || pathname.match(RE_NETWORK_FIRST_ASSETS)) {
      e.respondWith(respondWithCacheNetworkFirst(e));
      return true;
    }

    if (pathname.match(RE_CACHE_FIRST_ASSETS)) {
      e.respondWith(respondWithCache(e));
      return true;
    }
  }

  return false;
});

self.addEventListener('push', handlePush);
self.addEventListener('notificationclick', handleNotificationClick);
self.addEventListener('message', (event) => {
  handleNotificationMessage(event);
  handleShareMessage(event);
});
