// Ввод текстом: подсказки окна «Новая запись» — прежние строки пользователя вместо постоянных примеров.
//
// Приватность и хранение. История набранных строк — часть данных «Плана» (`PlannerState.quickLines`, запись
// на строку в зашифрованном контейнере): едет на все устройства пользователя и переживает выход, сервер
// её не видит. `QuickHistory` — рабочий вид для правил ниже: `historyFromLines` / `historyToLines`. Пока
// «План» на устройстве недоступен (устройство не привязано, нет ключа, движок прежней сборки), история
// ведётся в `localStorage`, как раньше; когда «План» готов, запись устройства вливается в него
// (`mergeHistories`) и стирается — тем же порядком, что словарь правок (`plannerQuickLearn.ts`).
// Сведение между устройствами — у движка: записи объединяются по строке, у одной строки побеждает позднее
// использование, «Забыть» — надгробие (не возвращается, пока строкой не воспользуются снова). Строки
// второго источника собираются из данных «Плана», которые уже лежат на устройстве расшифрованными.
// Сети модуль не касается.
//
// Источники, по убыванию доверия:
//   history — строки, которыми пользователь добавил запись в этом окне, дословно (`QuickHistory`);
//   data    — строки, собранные из задач и событий «Плана» (`draftToLine` — разбор наоборот): подсказки
//             есть и на новом устройстве, и для записей, созданных полной формой;
//   example — встроенные примеры, когда своих строк мало либо нет.
// Подсказка — шаблон новой записи, а не копия прежней: собранная строка несёт название, время,
// длительность, повтор и список, но не дату.
//
// Список кандидатов собирается один раз при открытии окна (`buildCandidates`: каждая строка разбирается,
// строка с ошибкой разбора отбрасывается), на каждое нажатие клавиши он только фильтруется
// (`filterSuggestions`) — без разбора.

import type {
  PlannerEvent, PlannerQuickLine, PlannerRepeat, PlannerRepeatKind, PlannerTask,
} from './plannerModel';
import type {
  QuickContext, QuickDraft, QuickKind, QuickLang,
} from './plannerQuick';

import { toMinutes } from './plannerModel';
import { parseQuickInput, QUICK_TASK_MINUTES, quickUsualMinutes } from './plannerQuick';

export type QuickSuggestionSource = 'history' | 'data' | 'example';
export type QuickSuggestion = { text: string; source: QuickSuggestionSource };
export type QuickCandidate = QuickSuggestion & {
  // Ключ шаблона: строки, отличающиеся только датой, — один кандидат
  key: string;
  // Свёрнутая строка, её слова и слова названия — для фильтра
  line: string;
  words: string[];
  nameWords: string[];
  // Сколько раз строка добавлена либо сколько записей «Плана» ей отвечают; свежесть (больше — новее)
  count: number;
  at: number;
  // Строки истории, которые кандидат представляет: «Забыть» стирает их все
  texts: string[];
  // Вид записи строки — подсказки окна, открытого под вид (сон, спорт, еда…), только этого вида
  kind: QuickKind;
};

export type QuickHistoryLine = { text: string; count: number; at: number };
// `lines` — от новых к старым; `hidden` — ключи шаблонов, которые пользователь попросил забыть
export type QuickHistory = { tick: number; lines: QuickHistoryLine[]; hidden: string[] };

export type QuickSuggestSources = {
  history: QuickHistory;
  tasks: PlannerTask[];
  events: PlannerEvent[];
  examples: string[];
};

// Задача либо событие в том виде, в каком его описывает строка
export type QuickLineDraft = {
  kind: 'task' | 'event';
  name: string;
  start?: string;
  // Событие: конец; длительность — разность с началом
  end?: string;
  isAllDay?: boolean;
  // Задача: оценка
  minutes?: number;
  repeat?: Pick<PlannerRepeat, 'kind' | 'interval' | 'weekdays'>;
  list?: string;
};

export const MAX_SUGGESTIONS = 8;
// Столько последних строк помнит история и столько же забытых шаблонов (как потолки движка `MAX_QUICK_LIVE`)
export const HISTORY_MAX_LINES = 200;
export const HISTORY_MAX_HIDDEN = 200;
// Потолок строки в данных «Плана» — в байтах UTF-8 (схема `QuickLine.text`)
const MAX_LINE_BYTES = 1200;
const LINE_ID_PREFIX = 'q';
const HIDDEN_ID_PREFIX = 'h';
const HISTORY_VERSION = 1;
const HISTORY_KEY_PREFIX = 'parvane:quick-history:';
const MAX_LINE_LENGTH = 300;
// Столько последних задач и столько же событий «Плана» становятся строками
const MAX_DATA_ENTRIES = 150;
// Слово короче ищется только с начала слова: одна буква «внутри» есть почти в любой строке
const MIN_CONTAINS_LENGTH = 2;
const MINUTES_IN_HOUR = 60;
const WORKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 0];
const LIST_PATTERN = /^\p{L}[\p{L}\p{N}_-]*$/u;
// Старшинство совпадений: строка начинается с набранного, слово названия начинается с недописанного слова,
// недописанное слово встречается в строке
const MATCH_CLASSES = 3;
const SOURCE_RANK: Record<QuickSuggestionSource, number> = { history: 0, data: 1, example: 2 };

type LineWords = {
  task: string;
  event: string;
  // По `Date.getDay`: 0 — воскресенье
  weekdays: string[];
  workdays: string;
  weekends: string;
  // Один день недели словами повтора и несколько дней
  single: (weekday: string) => string;
  several: (weekdays: string) => string;
  every: (kind: PlannerRepeatKind, interval: number) => string;
  hour: string;
  minute: string;
};

const RU_UNITS: Record<PlannerRepeatKind, [one: string, few: string, many: string]> = {
  daily: ['день', 'дня', 'дней'],
  weekly: ['неделю', 'недели', 'недель'],
  monthly: ['месяц', 'месяца', 'месяцев'],
  yearly: ['год', 'года', 'лет'],
};
const RU_EVERY: Record<PlannerRepeatKind, string> = {
  daily: 'каждый день', weekly: 'каждую неделю', monthly: 'каждый месяц', yearly: 'каждый год',
};
const EN_UNITS: Record<PlannerRepeatKind, string> = {
  daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year',
};

// Слова, которыми строка собирается: те же, что понимает разбор (`WORDS` в `plannerQuick.ts`)
const LINE_WORDS: Record<QuickLang, LineWords> = {
  ru: {
    task: 'задача',
    event: 'событие',
    weekdays: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
    workdays: 'по будням',
    weekends: 'по выходным',
    single: (weekday) => `по ${weekday}`,
    several: (weekdays) => `по ${weekdays}`,
    every: (kind, interval) => (
      interval === 1 ? RU_EVERY[kind] : `каждые ${interval} ${pluralRu(interval, RU_UNITS[kind])}`
    ),
    hour: 'ч',
    minute: 'мин',
  },
  en: {
    task: 'task',
    event: 'event',
    weekdays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    workdays: 'on weekdays',
    weekends: 'on weekends',
    single: (weekday) => `every ${weekday}`,
    several: (weekdays) => `on ${weekdays}`,
    every: (kind, interval) => (interval === 1 ? `every ${EN_UNITS[kind]}` : `every ${interval} ${EN_UNITS[kind]}s`),
    hour: 'h',
    minute: 'min',
  },
};

// ── подсказки ────────────────────────────────────────────────────────────────

// Разбор строк истории и примеров и проверка строк записей — самое дорогое в сборке кандидатов (сотни
// разборов); результаты запоминаются на уровне модуля для текущего контекста разбора. Смена контекста (день,
// окно дня, язык, словарь правок) кэш сбрасывает; минута «сейчас» на кандидатов не влияет и в ключ не входит
let cacheContextKey = '';
const parsedLines = new Map<string, QuickDraft>();
const verifiedLines = new Map<string, string | undefined>();

function contextKey(ctx: QuickContext) {
  const { nowMinutes, ...rest } = ctx;
  return JSON.stringify(rest);
}

function syncCacheContext(ctx: QuickContext) {
  const key = contextKey(ctx);
  if (key === cacheContextKey) return;
  cacheContextKey = key;
  parsedLines.clear();
  verifiedLines.clear();
}

function parseCached(text: string, ctx: QuickContext) {
  let draft = parsedLines.get(text);
  if (!draft) {
    draft = parseQuickInput(text, ctx);
    parsedLines.set(text, draft);
  }
  return draft;
}

/** Подсказки для набранного: список кандидатов собирается заново. Окну — `buildCandidates` один раз. */
export function buildSuggestions(input: string, sources: QuickSuggestSources, ctx: QuickContext) {
  return filterSuggestions(input, buildCandidates(sources, ctx));
}

/**
 * Кандидаты всех источников в порядке старшинства при прочих равных: чаще, затем источник (история, данные
 * «Плана», примеры), затем новее. Строка с ошибкой разбора кандидатом не становится.
 */
export function buildCandidates(sources: QuickSuggestSources, ctx: QuickContext): QuickCandidate[] {
  syncCacheContext(ctx);
  const uiLang = ctx.lang || 'ru';
  const byKey = new Map<string, QuickCandidate>();
  const lines = new Set<string>();
  const add = (candidate: QuickCandidate) => {
    byKey.set(candidate.key, candidate);
    lines.add(candidate.line);
  };

  sources.history.lines.forEach(({ text, count, at }) => {
    const draft = parseCached(text, ctx);
    if (draft.error) return;
    const key = lineKey(text, draft, uiLang);
    const known = byKey.get(key);
    // Строки одного шаблона («созвон завтра 16:00», «созвон пт 16:00»): показывается самая свежая
    if (known) {
      known.count += count;
      known.texts.push(text);
      return;
    }
    add(makeCandidate(text, 'history', key, draft.name, count, at, [text], draft.kind));
  });

  const hidden = new Set(sources.history.hidden);
  collectEntries(sources, uiLang).forEach(({
    key, draft, lang, count, at,
  }) => {
    const known = byKey.get(key);
    // Запись, добавленная этой же строкой истории, новой подсказки не даёт — только вес
    if (known) {
      known.count = Math.max(known.count, count);
      return;
    }
    if (hidden.has(key)) return;
    // Шаблон записи уже проверялся в этом контексте — строка берётся из кэша
    const cacheKey = `${key}\u0001${draft.name}`;
    const text = verifiedLines.has(cacheKey) ? verifiedLines.get(cacheKey) : verifiedLine(draft, lang, ctx);
    verifiedLines.set(cacheKey, text);
    if (text && !lines.has(foldLine(text))) {
      add(makeCandidate(text, 'data', key, draft.name, count, at, [], draft.kind));
    }
  });

  sources.examples.forEach((example, index) => {
    const text = normalizeLine(example);
    const key = foldLine(text);
    if (!text || lines.has(key) || byKey.has(key)) return;
    const draft = parseCached(text, ctx);
    if (!draft.error) {
      add(makeCandidate(text, 'example', key, draft.name, 0, -MAX_DATA_ENTRIES - 1 - index, [], draft.kind));
    }
  });

  return [...byKey.values()].sort(compareCandidates);
}

/**
 * Подсказки для набранного. Пустая строка — первые по старшинству (свои, затем примеры). Иначе — только
 * подходящие: последнее недописанное слово — начало слова, прежние слова обязаны быть в строке целиком.
 * Строка, равная набранной, не предлагается; ничего не подошло — список пуст.
 */
export function filterSuggestions(
  input: string, allCandidates: QuickCandidate[], limit = MAX_SUGGESTIONS, kinds?: QuickKind[],
): QuickSuggestion[] {
  // Окно под вид: только строки этого вида (свои — первыми, затем примеры)
  const candidates = kinds ? allCandidates.filter(({ kind }) => kinds.includes(kind)) : allCandidates;
  const typed = foldLine(input.replace(/\s+/g, ' ').trimStart());
  const whole = typed.trimEnd();
  const picked: QuickCandidate[] = [];
  if (!whole) {
    picked.push(...candidates.slice(0, limit));
  } else {
    const words = tokenize(typed);
    // Строка кончается буквой либо цифрой — последнее слово ещё дописывается
    const prefix = /[\p{L}\p{N}]$/u.test(typed) ? words.pop() : undefined;
    const classes: QuickCandidate[][] = Array.from({ length: MATCH_CLASSES }, () => []);
    candidates.forEach((candidate) => {
      const matched = matchClass(candidate, typed, whole, words, prefix);
      if (matched !== undefined) classes[matched].push(candidate);
    });
    picked.push(...classes.flat().slice(0, limit));
  }
  return picked.map(({ text, source }) => ({ text, source }));
}

/** Набранное — начало подсказки, но не вся она: такую подсказку принимает Tab. */
export function isSuggestionPrefix(input: string, suggestion: string) {
  const typed = foldLine(input.replace(/\s+/g, ' ').trimStart());
  const line = foldLine(normalizeLine(suggestion));
  return Boolean(typed.trim()) && line.startsWith(typed) && line !== typed.trimEnd();
}

/** Ключ шаблона добавленной строки: задача и событие — строка без даты, остальное — сама строка. */
export function lineKey(text: string, draft: QuickDraft, uiLang: QuickLang) {
  if (draft.kind !== 'task' && draft.kind !== 'event') return foldLine(normalizeLine(text));
  const lineDraft: QuickLineDraft = {
    kind: draft.kind,
    name: draft.name,
    start: draft.isAllDay ? undefined : draft.start,
    end: draft.end,
    isAllDay: draft.isAllDay,
    minutes: draft.minutes,
    repeat: draft.repeat,
    list: draft.list,
  };
  return foldLine(draftToLine(lineDraft, pickLineLang(draft.name, uiLang)));
}

function matchClass(candidate: QuickCandidate, typed: string, whole: string, words: string[], prefix?: string) {
  const { line, nameWords } = candidate;
  if (line === whole) return undefined;
  if (line.startsWith(typed)) return 0;
  // Дописанные слова — слова строки целиком
  if (!words.every((item) => candidate.words.includes(item))) return undefined;
  if (prefix === undefined) return words.some((item) => nameWords.includes(item)) ? 1 : 2;
  if (nameWords.some((item) => item.startsWith(prefix))) return 1;
  const isContained = prefix.length >= MIN_CONTAINS_LENGTH ? line.includes(prefix)
    : candidate.words.some((item) => item.startsWith(prefix));
  return isContained ? 2 : undefined;
}

function compareCandidates(a: QuickCandidate, b: QuickCandidate) {
  return b.count - a.count || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.at - a.at;
}

function makeCandidate(
  text: string, source: QuickSuggestionSource, key: string, name: string, count: number, at: number, texts: string[],
  kind: QuickKind,
): QuickCandidate {
  const line = foldLine(normalizeLine(text));
  const words = tokenize(line);
  const nameWords = tokenize(foldLine(name));
  // У записей здоровья названия нет: строка ищется по своим словам
  return {
    text, source, key, line, words, nameWords: nameWords.length ? nameWords : words, count, at, texts, kind,
  };
}

type DataEntry = { key: string; draft: QuickLineDraft; lang: QuickLang; count: number; at: number };

// Задачи и события «Плана», сведённые к шаблонам: одинаковые записи — один шаблон со счётчиком. Времени
// создания у записей нет — свежесть берётся по месту в данных (позже в списке — новее)
function collectEntries({ tasks, events }: QuickSuggestSources, uiLang: QuickLang) {
  const byKey = new Map<string, DataEntry>();
  const put = (draft: QuickLineDraft, at: number) => {
    const name = normalizeLine(draft.name);
    // Многострочное название одной строкой не записать
    if (!name || /\n/.test(draft.name)) return;
    const lang = pickLineLang(name, uiLang);
    const key = foldLine(draftToLine({ ...draft, name }, lang));
    const known = byKey.get(key);
    if (known) {
      known.count += 1;
      known.at = Math.max(known.at, at);
    } else {
      byKey.set(key, {
        key, draft: { ...draft, name }, lang, count: 1, at,
      });
    }
  };
  // Отделённый экземпляр ряда — не отдельное дело
  tasks.filter(({ origin }) => !origin).slice(-MAX_DATA_ENTRIES).reverse().forEach((task, index) => put({
    kind: 'task',
    name: task.name,
    start: task.start,
    minutes: task.minutes,
    repeat: task.repeat,
    list: task.project || undefined,
  }, -index));
  events.filter(({ origin }) => !origin).slice(-MAX_DATA_ENTRIES).reverse().forEach((event, index) => put({
    kind: 'event',
    name: event.name,
    start: event.isAllDay ? undefined : event.start,
    end: event.isAllDay ? undefined : event.end,
    isAllDay: event.isAllDay,
    repeat: event.repeat,
    list: event.project || undefined,
  }, -index));
  return [...byKey.values()];
}

// Строка записи, проверенная разбором: предлагается, только если разбор вернёт ту же запись. Сначала
// обычная запись, затем полная (слово типа, длительность и повтор названы явно); не вышло — подсказки нет
function verifiedLine(draft: QuickLineDraft, lang: QuickLang, ctx: QuickContext) {
  return [false, true].map((isExplicit) => draftToLine(draft, lang, isExplicit)).find((line) => (
    line.length <= MAX_LINE_LENGTH && isSameEntry(parseQuickInput(line, ctx), draft)
  ));
}

function isSameEntry(parsed: QuickDraft, draft: QuickLineDraft) {
  if (parsed.error || parsed.kind !== draft.kind || parsed.name !== draft.name) return false;
  if (parsed.description || parsed.due || parsed.place || parsed.isImportant) return false;
  if ((parsed.list || '').toLowerCase() !== (lineList(draft.list) || '').toLowerCase()) {
    return false;
  }
  if (!isSameRepeat(parsed.repeat, draft.repeat)) return false;
  // День в строку не пишется: названный днём кусок названия — не та запись
  if (!draft.repeat && parsed.day && !parsed.isDayAssumed) return false;
  if (draft.kind === 'task') return parsed.start === draft.start && parsed.minutes === draft.minutes;
  if (draft.isAllDay) return Boolean(parsed.isAllDay);
  return !parsed.isAllDay && parsed.start === draft.start && parsed.end === draft.end;
}

function isSameRepeat(parsed?: PlannerRepeat, repeat?: QuickLineDraft['repeat']) {
  if (!parsed || !repeat) return !parsed && !repeat;
  if (parsed.kind !== repeat.kind || parsed.interval !== repeat.interval || parsed.endDay || parsed.count) return false;
  if (repeat.kind !== 'weekly') return true;
  const days = (list?: number[]) => [...(list || [])].sort((a, b) => a - b).join();
  return days(parsed.weekdays) === days(repeat.weekdays);
}

// ── строка из записи ─────────────────────────────────────────────────────────

/**
 * Разбор наоборот: строка, которую `parseQuickInput` прочитает как эту задачу либо событие. Порядок слов —
 * [тип] название [дни недели] [время] [длительность] [повтор] [#группа]. В строку попадает:
 *   слово типа — только когда разбор сам выбрал бы другой тип (задача со временем, событие без времени);
 *   длительность — у события, когда она не обычная для первого слова названия («созвон» — 30 мин, «пара» —
 *     1 ч 45 мин, прочее — час), у задачи — оценка (у задачи со временем — когда она не полчаса);
 *   повтор — самой простой записью: «каждый день», «пн … каждую неделю», «по пн, ср», «по будням»,
 *     «каждые 2 недели»; число месяца, конец ряда и число повторов не пишутся;
 *   группа задачи либо события — меткой `#группа` (пробел в названии — «_»), если название годится в метку.
 * Не попадает: дата (подсказка — шаблон новой записи), срок, описание, место, «важное», цвет, шаги.
 * `isExplicit` — полная запись: слово типа и длительность названы всегда, один день недели — словами
 * повтора («по пн»); нужна, когда обычную запись разбор читает иначе.
 */
export function draftToLine(draft: QuickLineDraft, lang: QuickLang, isExplicit?: boolean) {
  const words = LINE_WORDS[lang];
  const isEvent = draft.kind === 'event';
  const hasTime = Boolean(draft.start) && !draft.isAllDay;
  const [days, every] = draft.repeat ? formatLineRepeat(draft.repeat, words, isExplicit) : [];
  const minutes = getLineMinutes(draft, lang, hasTime, isExplicit);
  const list = lineList(draft.list);
  return [
    isExplicit || isEvent !== hasTime ? (isEvent ? words.event : words.task) : undefined,
    normalizeLine(draft.name),
    days,
    hasTime ? draft.start : undefined,
    minutes ? formatLineMinutes(minutes, words) : undefined,
    every,
    list && `#${list.replace(/ /g, '_')}`,
  ].filter(Boolean).join(' ');
}

function getLineMinutes(draft: QuickLineDraft, lang: QuickLang, hasTime: boolean, isExplicit?: boolean) {
  if (draft.kind === 'task') {
    return !isExplicit && hasTime && draft.minutes === QUICK_TASK_MINUTES ? undefined : draft.minutes;
  }
  if (!hasTime || !draft.end) return undefined;
  const span = toMinutes(draft.end) - toMinutes(draft.start!);
  return span > 0 && (isExplicit || span !== quickUsualMinutes(draft.name, lang)) ? span : undefined;
}

function formatLineMinutes(minutes: number, words: LineWords) {
  const hours = Math.floor(minutes / MINUTES_IN_HOUR);
  const rest = minutes % MINUTES_IN_HOUR;
  return [hours && `${hours} ${words.hour}`, rest && `${rest} ${words.minute}`].filter(Boolean).join(' ');
}

// Дни недели (до времени) и слова повтора (после длительности)
function formatLineRepeat(
  repeat: NonNullable<QuickLineDraft['repeat']>, words: LineWords, isExplicit?: boolean,
): [days?: string, every?: string] {
  const { kind, interval } = repeat;
  const every = words.every(kind, interval);
  // Понедельник — первым
  const weekdays = [...new Set(repeat.weekdays || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (kind !== 'weekly' || !weekdays.length) return [undefined, every];
  if (weekdays.length === 1 && !isExplicit) return [words.weekdays[weekdays[0]], every];
  const isSet = (set: number[]) => weekdays.length === set.length && set.every((day) => weekdays.includes(day));
  const days = isSet(WORKDAYS) ? words.workdays : isSet(WEEKEND) ? words.weekends
    : weekdays.length === 1 ? words.single(words.weekdays[weekdays[0]])
      : words.several(weekdays.map((day) => words.weekdays[day]).join(', '));
  return [days, interval > 1 ? every : undefined];
}

// Название списка, годное в метку `#…`
function lineList(list?: string) {
  const name = list && normalizeLine(list);
  return name && LIST_PATTERN.test(name.replace(/ /g, '_')) ? name : undefined;
}

// Язык слов строки — по буквам названия: «созвон» получает русские слова и при английском интерфейсе,
// иначе разбор не узнает его обычную длительность
function pickLineLang(name: string, uiLang: QuickLang): QuickLang {
  const hasRu = /[а-яё]/i.test(name);
  const hasEn = /[a-z]/i.test(name);
  return hasRu === hasEn ? uiLang : hasRu ? 'ru' : 'en';
}

function pluralRu(count: number, [one, few, many]: [string, string, string]) {
  const ones = count % 10;
  const tens = count % 100;
  if (ones === 1 && tens !== 11) return one;
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? few : many;
}

function normalizeLine(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

// Сравнение без регистра, «ё» — «е»
function foldLine(text: string) {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function tokenize(folded: string) {
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// ── история набранных строк ──────────────────────────────────────────────────

export function createQuickHistory(): QuickHistory {
  return { tick: 0, lines: [], hidden: [] };
}

/**
 * Запомнить строку, которой добавлена запись. Та же строка (без учёта регистра и лишних пробелов) не
 * дублируется: растёт счётчик, строка становится самой свежей. `key` — ключ её шаблона (`lineKey`):
 * добавленное снова перестаёт быть забытым.
 */
export function recordHistoryLine(history: QuickHistory, typed: string, key: string): QuickHistory {
  const text = normalizeLine(typed);
  if (!text || text.length > MAX_LINE_LENGTH) return history;
  const folded = foldLine(text);
  const known = history.lines.find((line) => foldLine(line.text) === folded);
  const tick = history.tick + 1;
  return {
    tick,
    lines: [
      { text, count: (known?.count || 0) + 1, at: tick }, ...history.lines.filter((line) => line !== known),
    ].slice(0, HISTORY_MAX_LINES),
    hidden: history.hidden.filter((item) => item !== key),
  };
}

/** Забыть подсказку: её строки истории стираются, а шаблон больше не собирается из данных «Плана». */
export function forgetSuggestion(history: QuickHistory, { key, texts }: Pick<QuickCandidate, 'key' | 'texts'>) {
  const folded = new Set(texts.map(foldLine));
  return {
    tick: history.tick,
    lines: history.lines.filter(({ text }) => !folded.has(foldLine(text))),
    hidden: [key, ...history.hidden.filter((item) => item !== key)].slice(0, HISTORY_MAX_HIDDEN),
  } satisfies QuickHistory;
}

export function hasHistory(history: QuickHistory) {
  return history.lines.length > 0 || history.hidden.length > 0;
}

// ── история в данных «Плана» ─────────────────────────────────────────────────

const HASH_SEEDS = [0xdeadbeef, 0x41c6ce57];
const HASH_STEPS = [2654435761, 1597334677];
const HASH_MIX = [2246822507, 3266489909];
const HASH_SHIFTS = [16, 13];
const HEX = 16;
const HASH_PART_LENGTH = 8;

// Хэш строки (cyrb53, обе половины): шестнадцать шестнадцатеричных цифр. Не криптография — только ключ
// записи, одинаковый на всех устройствах; движок принимает в ключе латиницу и цифры
function hashLine(text: string) {
  let [h1, h2] = HASH_SEEDS;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, HASH_STEPS[0]);
    h2 = Math.imul(h2 ^ code, HASH_STEPS[1]);
  }
  h1 = Math.imul(h1 ^ (h1 >>> HASH_SHIFTS[0]), HASH_MIX[0]) ^ Math.imul(h2 ^ (h2 >>> HASH_SHIFTS[1]), HASH_MIX[1]);
  h2 = Math.imul(h2 ^ (h2 >>> HASH_SHIFTS[0]), HASH_MIX[0]) ^ Math.imul(h1 ^ (h1 >>> HASH_SHIFTS[1]), HASH_MIX[1]);
  return [h2, h1].map((part) => (part >>> 0).toString(HEX).padStart(HASH_PART_LENGTH, '0')).join('');
}

/**
 * Ключ записи истории в данных «Плана». Строка — по её виду без регистра и лишних пробелов (одна и та же
 * строка с двух устройств — одна запись), забытый шаблон — по ключу шаблона.
 */
export function quickLineId(text: string, isHidden?: boolean) {
  return `${isHidden ? HIDDEN_ID_PREFIX : LINE_ID_PREFIX}${hashLine(foldLine(normalizeLine(text)))}`;
}

// Движок принимает одну строку без управляющих знаков, не длиннее потолка в байтах
function isSyncedLine(text: string) {
  return !/\p{Cc}/u.test(text) && new TextEncoder().encode(text).length <= MAX_LINE_BYTES;
}

/** Записи из данных «Плана» → рабочая история: строки от новых к старым, забытые шаблоны — так же. */
export function historyFromLines(lines: PlannerQuickLine[]): QuickHistory {
  const history = createQuickHistory();
  const seen = new Set<string>();
  [...lines].sort((a, b) => b.touched - a.touched || (a.id < b.id ? -1 : 1)).forEach((line) => {
    history.tick = Math.max(history.tick, line.touched);
    const text = normalizeLine(line.text);
    const mark = `${line.isHidden ? HIDDEN_ID_PREFIX : LINE_ID_PREFIX}${foldLine(text)}`;
    if (!text || text.length > MAX_LINE_LENGTH || seen.has(mark)) return;
    seen.add(mark);
    if (line.isHidden) history.hidden.push(text);
    else history.lines.push({ text, count: Math.max(1, line.count), at: line.touched });
  });
  history.lines = history.lines.slice(0, HISTORY_MAX_LINES);
  history.hidden = history.hidden.slice(0, HISTORY_MAX_HIDDEN);
  return history;
}

/**
 * Рабочая история → записи для данных «Плана» (по ключу; непригодное движку пропускается). `previous` —
 * записи в данных сейчас: забытый шаблон, который в них уже есть, сохраняет свою свежесть, новый получает
 * текущую.
 */
export function historyToLines(history: QuickHistory, previous: PlannerQuickLine[] = []): PlannerQuickLine[] {
  const known = new Map(previous.map((line) => [line.id, line]));
  const lines: PlannerQuickLine[] = [];
  history.lines.slice(0, HISTORY_MAX_LINES).forEach(({ text, count, at }) => {
    if (isSyncedLine(text)) {
      lines.push({
        id: quickLineId(text), text, count, touched: at,
      });
    }
  });
  history.hidden.slice(0, HISTORY_MAX_HIDDEN).forEach((key) => {
    if (!isSyncedLine(key)) return;
    const id = quickLineId(key, true);
    lines.push({
      id, text: key, count: 0, touched: known.get(id)?.touched ?? history.tick, isHidden: true,
    });
  });
  return lines.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Влить запись устройства в историю из данных «Плана». Строка, которая есть в обеих, не складывается:
 * остаётся запись «Плана» с большим из двух счётчиков. Строки только с устройства становятся самыми
 * свежими, в прежнем порядке между собой; забытые на устройстве шаблоны добавляются к забытым.
 */
export function mergeHistories(synced: QuickHistory, local: QuickHistory): QuickHistory {
  if (!hasHistory(local)) return synced;
  const lines = synced.lines.map((line) => ({ ...line }));
  const byFold = new Map(lines.map((line) => [foldLine(line.text), line]));
  let { tick } = synced;
  [...local.lines].sort((a, b) => a.at - b.at).forEach((mine) => {
    const known = byFold.get(foldLine(mine.text));
    if (known) {
      known.count = Math.max(known.count, mine.count);
      return;
    }
    tick += 1;
    lines.push({ text: mine.text, count: mine.count, at: tick });
  });
  return {
    tick,
    lines: lines.sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX_LINES),
    hidden: [...synced.hidden, ...local.hidden.filter((key) => !synced.hidden.includes(key))]
      .slice(0, HISTORY_MAX_HIDDEN),
  };
}

/**
 * Добавленная строка для данных «Плана»: `lines` — история в них сейчас, `local` — ещё не перенесённая
 * запись устройства. Возвращает новый список записей.
 */
export function recordQuickLine(lines: PlannerQuickLine[], local: QuickHistory, typed: string, key: string) {
  return historyToLines(recordHistoryLine(mergeHistories(historyFromLines(lines), local), typed, key), lines);
}

/** «Забыть» для данных «Плана»: строки подсказки уходят, её шаблон становится забытым. */
export function forgetQuickLine(
  lines: PlannerQuickLine[], local: QuickHistory, candidate: Pick<QuickCandidate, 'key' | 'texts'>,
) {
  return historyToLines(forgetSuggestion(mergeHistories(historyFromLines(lines), local), candidate), lines);
}

// ── запись устройства (запасной путь) ────────────────────────────────────────

export function serializeHistory(history: QuickHistory) {
  return JSON.stringify({ v: HISTORY_VERSION, ...history });
}

/** История из строки хранилища; испорченное и незнакомое пропускается. */
export function parseHistory(saved: string | undefined): QuickHistory {
  const history = createQuickHistory();
  if (!saved) return history;
  let data: unknown;
  try {
    data = JSON.parse(saved);
  } catch (err) {
    return history;
  }
  if (!data || typeof data !== 'object') return history;
  const { v, tick, lines, hidden } = data as Record<string, unknown>;
  if (v !== HISTORY_VERSION) return history;
  const seen = new Set<string>();
  (Array.isArray(lines) ? lines : []).forEach((item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const { text, count, at } = item as Record<string, unknown>;
    const line = typeof text === 'string' ? normalizeLine(text) : '';
    if (!line || line.length > MAX_LINE_LENGTH || seen.has(foldLine(line))) return;
    seen.add(foldLine(line));
    history.lines.push({
      text: line,
      count: Number.isInteger(count) && (count as number) > 0 ? count as number : 1,
      at: Number.isInteger(at) ? at as number : 0,
    });
  });
  history.lines = history.lines.sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX_LINES);
  history.hidden = (Array.isArray(hidden) ? hidden : [])
    .filter((item): item is string => typeof item === 'string' && item.length <= MAX_LINE_LENGTH)
    .slice(0, HISTORY_MAX_HIDDEN);
  history.tick = Math.max(Number.isInteger(tick) ? tick as number : 0, ...history.lines.map(({ at }) => at));
  return history;
}

function historyKey(userId?: string) {
  return `${HISTORY_KEY_PREFIX}${userId || 'local'}`;
}

// Хранилище может быть недоступно — тогда истории нет и строки не запоминаются
export function readHistory(userId?: string): QuickHistory {
  try {
    return parseHistory(localStorage.getItem(historyKey(userId)) || undefined);
  } catch (err) {
    return createQuickHistory();
  }
}

export function saveHistory(userId: string | undefined, history: QuickHistory) {
  try {
    localStorage.setItem(historyKey(userId), serializeHistory(history));
  } catch (err) {
    // Строка просто не запомнится
  }
}

export function resetHistory(userId?: string) {
  try {
    localStorage.removeItem(historyKey(userId));
  } catch (err) {
    // Стирать нечего
  }
}
