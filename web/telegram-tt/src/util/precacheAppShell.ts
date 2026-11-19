import { getGlobal, setGlobal } from '../global';

// Оболочка приложения для запуска без сети (spec 041 F1): страница просит сервис-воркер положить в кэш все файлы
// сборки (`serviceWorker/precache.ts`). Просьба повторяется при возвращении к вкладке: после выкладки новая версия
// скачивается заранее, и перезагрузка на неё не зависит от сети
const PRECACHE_MESSAGE = 'parvanePrecache';
const PRECACHE_DONE_MESSAGE = 'parvanePrecacheDone';
const PRECACHE_DELAY_MS = 3000;
const PRECACHE_REPEAT_MS = 10 * 60 * 1000;
// Сценарии и диагностика читают отсюда сборку, чья оболочка лежит в кэше целиком
const READY_ATTRIBUTE = 'data-app-shell';

let lastRequestAt = 0;

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
export function handleAppShellMessage(type: string, payload?: { build?: string }) {
  if (type !== PRECACHE_DONE_MESSAGE || !payload?.build) return;
  document.documentElement.setAttribute(READY_ATTRIBUTE, payload.build);

  let global = getGlobal();
  if (payload.build === APP_BUILD || global.isAppUpdateAvailable) return;
  global = { ...global, isAppUpdateAvailable: true };
  setGlobal(global);
}
