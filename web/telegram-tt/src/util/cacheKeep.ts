// «Хранить кэш» в «Данных и памяти» (доска `DkSettingsB`): сколько медиа чатов лежит в кэше браузера после последнего
// открытия. Настройка устройства; читает её и очистка кэша (`cacheApi.cleanup`, может идти в воркере без
// `localStorage` — тогда по умолчанию)
export type CacheKeep = 'week' | 'month' | 'quarter' | 'forever';

export const CACHE_KEEP_CHOICES: CacheKeep[] = ['week', 'month', 'quarter', 'forever'];

const STORAGE_KEY = 'parvane:cache-keep';
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS: Record<CacheKeep, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
  forever: Infinity,
};
const DEFAULT_KEEP: CacheKeep = 'month';

export function getCacheKeep(): CacheKeep {
  try {
    const value = localStorage.getItem(STORAGE_KEY) as CacheKeep | null;
    return value && value in KEEP_MS ? value : DEFAULT_KEEP;
  } catch {
    return DEFAULT_KEEP;
  }
}

export function setCacheKeep(value: CacheKeep) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Настройка действует до перезагрузки — дальше по умолчанию
  }
}

/** Сколько миллисекунд медиа держится в кэше после последнего открытия. */
export function getCacheKeepMs() {
  return KEEP_MS[getCacheKeep()];
}
