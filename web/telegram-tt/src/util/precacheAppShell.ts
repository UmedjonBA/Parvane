import { getGlobal, setGlobal } from '../global';

import { createSignal } from './signals';

// Оболочка приложения для запуска без сети (spec 041 F1): страница просит сервис-воркер положить в кэш все файлы
// сборки (`serviceWorker/precache.ts`). Просьба повторяется при возвращении к вкладке: после выкладки новая версия
// скачивается заранее, и перезагрузка на неё не зависит от сети
const PRECACHE_MESSAGE = 'parvanePrecache';
const PRECACHE_DONE_MESSAGE = 'parvanePrecacheDone';
const PRECACHE_PROGRESS_MESSAGE = 'parvanePrecacheProgress';
const PRECACHE_DELAY_MS = 3000;
const PRECACHE_REPEAT_MS = 10 * 60 * 1000;
// Сценарии и диагностика читают отсюда сборку, чья оболочка лежит в кэше целиком
const READY_ATTRIBUTE = 'data-app-shell';

let lastRequestAt = 0;

// Ход набора, о котором сообщил сервис-воркер (окно «Нужно обновить приложение», доска `ZdNav`)
export type AppShellProgress = { done: number; total: number };
const [getAppShellProgress, setAppShellProgress] = createSignal<AppShellProgress | undefined>(undefined);
// Сборка, чья оболочка лежит в кэше целиком (последний ответ сервис-воркера)
const [getCachedAppBuild, setCachedAppBuild] = createSignal<string | undefined>(undefined);

export { getAppShellProgress, getCachedAppBuild };

/** Сейчас, без паузы и без ограничения частоты: окно обновления ждёт новую сборку. */
export function requestAppShellPrecacheNow() {
  if (import.meta.env.DEV) return;
  lastRequestAt = Date.now();
  navigator.serviceWorker?.controller?.postMessage({ type: PRECACHE_MESSAGE });
}

/** Просит сервис-воркер скачать оболочку; не чаще раза в `PRECACHE_REPEAT_MS`. */
export function requestAppShellPrecache() {
  if (import.meta.env.DEV || Date.now() - lastRequestAt < PRECACHE_REPEAT_MS) return;
  // Режим экономии трафика: оболочка (около 5 МБ по сети) без спроса не качается
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  lastRequestAt = Date.now();

  setTimeout(() => {
    navigator.serviceWorker.controller?.postMessage({ type: PRECACHE_MESSAGE });
  }, PRECACHE_DELAY_MS);
}

/** Ответ сервис-воркера: оболочка сборки `build` в кэше. Чужая сборка — вышла новая версия. */
export function handleAppShellMessage(type: string, payload?: { build?: string; done?: number; total?: number }) {
  if (type === PRECACHE_PROGRESS_MESSAGE && payload?.total !== undefined) {
    setAppShellProgress({ done: payload.done || 0, total: payload.total });
    return;
  }
  if (type !== PRECACHE_DONE_MESSAGE || !payload?.build) return;
  document.documentElement.setAttribute(READY_ATTRIBUTE, payload.build);
  setCachedAppBuild(payload.build);

  let global = getGlobal();
  if (payload.build === APP_BUILD || global.isAppUpdateAvailable) return;
  global = { ...global, isAppUpdateAvailable: true };
  setGlobal(global);
}
