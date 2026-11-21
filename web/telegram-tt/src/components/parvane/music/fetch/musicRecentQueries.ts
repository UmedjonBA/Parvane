import { ACCOUNT_WIPED_EVENT } from '../../../../util/parvaneEvents';
import { createSignal } from '../../../../util/signals';

// Parvane (spec 041, доска `ZpMusicX`): «Недавние запросы» поиска «Музыки» — память устройства (стирается выходом
// вместе со всеми `parvane:*`), не больше `MAX_QUERIES`, новые первыми, без повторов

const KEY = 'parvane:music-searches';
const MAX_QUERIES = 8;
const QUERY_MAX = 120;

function readQueries(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === 'string').slice(0, MAX_QUERIES);
  } catch {
    return [];
  }
}

const [getRecentQueries, setRecentQueries] = createSignal<string[]>(typeof window === 'undefined' ? [] : readQueries());

export { getRecentQueries };

if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => setRecentQueries([]));
}

function writeQueries(queries: string[]) {
  setRecentQueries(queries);
  try {
    localStorage.setItem(KEY, JSON.stringify(queries));
  } catch {
    // Без памяти устройства список просто не переживёт перезагрузку
  }
}

/** Запомнить запрос: повтор (без учёта регистра) поднимается наверх. */
export function rememberQuery(query: string) {
  const text = query.trim().slice(0, QUERY_MAX);
  if (!text) return;
  const lower = text.toLowerCase();
  writeQueries([text, ...getRecentQueries().filter((item) => item.toLowerCase() !== lower)].slice(0, MAX_QUERIES));
}

export function forgetQuery(query: string) {
  writeQueries(getRecentQueries().filter((item) => item !== query));
}
