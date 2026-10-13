// Parvane: общий поиск (палитра Ctrl+K) — чистая часть: что и в каком порядке показать по запросу.
// Запись палитры — название, необязательный текст (описание задачи, текст заметки) и ключ действия

export type PaletteGroup = 'command' | 'chat' | 'note' | 'record';
export const PALETTE_GROUPS: PaletteGroup[] = ['command', 'chat', 'note', 'record'];

export type PaletteItem = {
  // Ключ действия, уникален в пределах палитры: `nav:today`, `chat:<id>`, `note:<id>`, `task:<id>`…
  key: string;
  group: PaletteGroup;
  title: string;
  // Текст, по которому запись тоже находится (в строке показывается отрывок вокруг совпадения)
  text?: string;
  // Те же строки, приведённые `normalizePaletteText`, — считаются один раз при сборке записи, а не на каждое
  // нажатие (E2: текст заметок — до мегабайта). Без них поиск нормализует сам
  normTitle?: string;
  normText?: string;
};

// Участок совпадения: начало и конец (не включая) в символах строки
export type PaletteRange = [number, number];

export type PaletteResult<T extends PaletteItem = PaletteItem> = {
  item: T;
  // Совпадения в названии
  ranges: PaletteRange[];
  // Отрывок текста с совпадением — только когда название запрос целиком не объясняет
  snippet?: { text: string; ranges: PaletteRange[] };
};

export type PaletteSection<T extends PaletteItem = PaletteItem> = {
  group: PaletteGroup;
  results: PaletteResult<T>[];
};

export const PALETTE_GROUP_LIMIT = 6;
// По текстам записей запрос ищется с этой длины (без пробелов): одна буква в текстах заметок находит почти всё
// и перебирает их целиком на первое же нажатие; запрос из нескольких слов с короткими («9 класс») ищется
export const TEXT_MIN_QUERY_LENGTH = 2;
const SNIPPET_BEFORE = 24;
const SNIPPET_LENGTH = 90;

const WORD_CHAR = /[\p{L}\p{N}]/u;

// Чем меньше, тем выше: слово запроса открывает название, начинает слово названия, стоит внутри слова,
// найдено только в тексте
const RANK_TITLE_START = 0;
const RANK_WORD_START = 1;
const RANK_INSIDE = 2;
const RANK_TEXT_WORD = 3;
const RANK_TEXT_INSIDE = 4;

/** Строка для сравнения: без регистра, «ё» = «е». Длина сохраняется — участки совпадения годятся для исходной. */
export function normalizePaletteText(value: string) {
  let result = '';
  for (const char of value) {
    const lower = char.toLowerCase();
    // Редкие буквы меняют длину при смене регистра («İ») — такие остаются как есть
    const safe = lower.length === char.length ? lower : char;
    result += safe === 'ё' ? 'е' : safe;
  }
  return result;
}

export function splitPaletteQuery(query: string) {
  return normalizePaletteText(query).split(/\s+/).filter(Boolean);
}

function isWordStart(text: string, index: number) {
  if (index === 0) return true;
  // Суррогатная пара перед совпадением — не буква и не цифра нашего алфавита: считаем началом слова
  return !WORD_CHAR.test(text[index - 1]);
}

// Лучшее вхождение слова запроса: сначала то, что начинает слово
function findTerm(text: string, term: string): { index: number; isWordStart: boolean } | undefined {
  let first = -1;
  for (let index = text.indexOf(term); index >= 0; index = text.indexOf(term, index + 1)) {
    if (isWordStart(text, index)) return { index, isWordStart: true };
    if (first < 0) first = index;
  }
  return first < 0 ? undefined : { index: first, isWordStart: false };
}

function mergeRanges(ranges: PaletteRange[]) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: PaletteRange[] = [];
  sorted.forEach(([from, to]) => {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  });
  return merged;
}

function buildSnippet(text: string, hits: PaletteRange[]) {
  const first = Math.min(...hits.map(([from]) => from));
  // Отрывок не выходит за строку текста, в которой стоит первое совпадение
  const lineStart = text.lastIndexOf('\n', first - 1) + 1;
  const lineEndRaw = text.indexOf('\n', first);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const from = Math.max(lineStart, first - SNIPPET_BEFORE);
  const to = Math.min(lineEnd, from + SNIPPET_LENGTH);
  const prefix = from > lineStart ? '…' : '';
  const suffix = to < lineEnd ? '…' : '';
  const ranges = mergeRanges(hits
    .filter(([hitFrom, hitTo]) => hitFrom >= from && hitTo <= to)
    .map(([hitFrom, hitTo]): PaletteRange => [hitFrom - from + prefix.length, hitTo - from + prefix.length]));
  return { text: `${prefix}${text.slice(from, to)}${suffix}`, ranges };
}

type Match<T extends PaletteItem> = PaletteResult<T> & { rank: number; order: number };

/** Запись с заранее приведёнными строками — для списков, которые собираются один раз на открытие палитры. */
export function withNormalized<T extends PaletteItem>(item: T): T {
  return {
    ...item,
    normTitle: normalizePaletteText(item.title),
    normText: item.text ? normalizePaletteText(item.text) : undefined,
  };
}

function matchItem<T extends PaletteItem>(
  item: T, terms: string[], order: number, withText: boolean,
): Match<T> | undefined {
  const title = item.normTitle ?? normalizePaletteText(item.title);
  const text = withText ? item.normText ?? (item.text ? normalizePaletteText(item.text) : '') : '';
  const ranges: PaletteRange[] = [];
  const textHits: PaletteRange[] = [];
  let rank = 0;
  for (const term of terms) {
    const inTitle = findTerm(title, term);
    if (inTitle) {
      ranges.push([inTitle.index, inTitle.index + term.length]);
      rank += inTitle.index === 0 ? RANK_TITLE_START : inTitle.isWordStart ? RANK_WORD_START : RANK_INSIDE;
      continue;
    }
    const inText = text ? findTerm(text, term) : undefined;
    if (!inText) return undefined;
    textHits.push([inText.index, inText.index + term.length]);
    rank += inText.isWordStart ? RANK_TEXT_WORD : RANK_TEXT_INSIDE;
  }
  return {
    item,
    ranges: mergeRanges(ranges),
    snippet: textHits.length ? buildSnippet(item.text!, textHits) : undefined,
    rank,
    order,
  };
}

/**
 * Результаты по группам в порядке `PALETTE_GROUPS`; пустые группы не возвращаются.
 * Внутри группы — по качеству совпадения, при равенстве — в порядке источника (он уже осмыслен:
 * заметки — свежие первыми). Пустой запрос показывает только команды, как в прототипе.
 */
export function searchPalette<T extends PaletteItem>(
  items: T[], query: string, limit = PALETTE_GROUP_LIMIT,
): PaletteSection<T>[] {
  const terms = splitPaletteQuery(query);
  const withText = terms.join('').length >= TEXT_MIN_QUERY_LENGTH;
  const byGroup = new Map<PaletteGroup, Match<T>[]>();
  items.forEach((item, order) => {
    let match: Match<T> | undefined;
    if (terms.length) {
      match = matchItem(item, terms, order, withText);
    } else if (item.group === 'command') {
      match = {
        item, ranges: [], rank: 0, order,
      };
    }
    if (!match) return;
    const list = byGroup.get(item.group);
    if (list) list.push(match);
    else byGroup.set(item.group, [match]);
  });
  const sections: PaletteSection<T>[] = [];
  PALETTE_GROUPS.forEach((group) => {
    const matches = byGroup.get(group);
    if (!matches) return;
    matches.sort((a, b) => a.rank - b.rank || a.order - b.order);
    // Команд немного, и без запроса они — всё содержимое палитры: их не обрезаем
    const shown = group === 'command' && !terms.length ? matches : matches.slice(0, limit);
    sections.push({ group, results: shown.map(({ item, ranges, snippet }) => ({ item, ranges, snippet })) });
  });
  return sections;
}

/** Строка с участками совпадения → куски для отрисовки (подсвеченные и обычные). */
export function splitByRanges(text: string, ranges: PaletteRange[]) {
  const parts: { text: string; isMatch: boolean }[] = [];
  let position = 0;
  ranges.forEach(([from, to]) => {
    if (from > position) parts.push({ text: text.slice(position, from), isMatch: false });
    parts.push({ text: text.slice(from, to), isMatch: true });
    position = to;
  });
  if (position < text.length) parts.push({ text: text.slice(position), isMatch: false });
  return parts;
}

/** Строка, выбранная стрелкой: список замкнут в кольцо, как в прототипе. */
export function movePaletteIndex(index: number, delta: number, count: number) {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}
