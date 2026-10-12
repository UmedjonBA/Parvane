// Ввод текстом: личный словарь правок. Разбор угадывает тип записи и длительность события; когда
// пользователь исправляет угаданное и добавляет запись, правка запоминается за первым словом названия
// (`QuickDraft.head`). Одна и та же правка `LEARN_THRESHOLD` раз становится значением по умолчанию — разбор
// получает его через `ctx.learned` и остаётся чистой функцией.
//
// Что считается правкой (сравниваются черновик без участия пользователя и добавленный):
//   тип — добавлена задача либо событие, а разбор той же строки сам выбрал бы другое (переключатель
//         типа; слово-тип в начале строки правкой не считается — с ним разбор и сам выбирает этот тип);
//   длительность — у события со временем длительность названа явно («20 мин», «15:00–16:20») и отличается
//         от обычной для этого слова.
// Значение, подставленное из словаря и принятое как есть, счётчик не меняет. Правка в другую сторону
// (другое значение явно либо снятый чип выученного значения) уменьшает счётчик; на нуле запись
// заменяется новой правкой либо удаляется. Явное значение в строке всегда сильнее выученного.
// Словарь — настройка устройства (`localStorage`), не синхронизируется.

import type { QuickDraft, QuickLearned, QuickLearnedKind } from './plannerQuick';

import { MINUTES_IN_DAY } from './plannerModel';

type Counted<T> = { value: T; count: number };
type LearnHead = { kind?: Counted<QuickLearnedKind>; minutes?: Counted<number>; at: number };
export type LearnStore = { tick: number; heads: Record<string, LearnHead> };

// Столько одинаковых правок делают значение умолчанием
export const LEARN_THRESHOLD = 3;
// Потолок счётчика: выученное снимается не более чем за три правки в другую сторону
export const LEARN_MAX_COUNT = 5;
// Столько первых слов помнит словарь; дольше всех не тронутые вытесняются
export const LEARN_MAX_HEADS = 200;

const STORE_VERSION = 1;
const KEY_PREFIX = 'parvane:quick-learned:';
const MAX_HEAD_LENGTH = 64;

export function createLearnStore(): LearnStore {
  return { tick: 0, heads: {} };
}

function isLearnedKind(kind: unknown): kind is QuickLearnedKind {
  return kind === 'task' || kind === 'event';
}

// Счётчик после правки: `value` — что выбрал пользователь, `base` — что разбор дал бы сам
function correct<T>(entry: Counted<T> | undefined, value: T, base: T): Counted<T> | undefined {
  if (!entry) return value !== base ? { value, count: 1 } : undefined;
  if (value === entry.value) {
    return value !== base ? { value, count: Math.min(entry.count + 1, LEARN_MAX_COUNT) } : entry;
  }
  if (entry.count > 1) return { value: entry.value, count: entry.count - 1 };
  return value !== base ? { value, count: 1 } : undefined;
}

/**
 * Учесть добавленную запись. `auto` — черновик той же строки без участия пользователя (тип не выбран,
 * ничего не снято, словарь не применён), `final` — добавленный черновик. Возвращает прежний объект,
 * если словарь не изменился.
 */
export function recordCorrection(store: LearnStore, auto: QuickDraft, final: QuickDraft): LearnStore {
  const head = final.head;
  if (!head || final.error || !isLearnedKind(final.kind)) return store;
  const known = Object.prototype.hasOwnProperty.call(store.heads, head) ? store.heads[head] : undefined;
  let kind = known?.kind;
  let minutes = known?.minutes;

  if (isLearnedKind(auto.kind) && !final.learned?.includes('kind')) {
    const isRejected = kind !== undefined && kind.count >= LEARN_THRESHOLD && final.kind !== kind.value;
    // Тип совпал с выбором разбора: это правка, только если отвергнуто выученное
    if (final.kind !== auto.kind || isRejected) kind = correct(kind, final.kind, auto.kind);
  }

  if (final.kind === 'event' && final.start && final.usualMinutes !== undefined
    && !final.learned?.includes('minutes')) {
    if (final.minutes !== undefined) {
      minutes = correct(minutes, final.minutes, final.usualMinutes);
    } else if (minutes && minutes.count >= LEARN_THRESHOLD && minutes.value !== final.usualMinutes) {
      // Выученная длительность снята чипом: событие добавлено с обычной
      minutes = correct(minutes, final.usualMinutes, final.usualMinutes);
    }
  }

  if (kind === known?.kind && minutes === known?.minutes) return store;
  const tick = store.tick + 1;
  const heads = { ...store.heads };
  if (kind || minutes) heads[head] = { kind, minutes, at: tick };
  else delete heads[head];
  return trim({ tick, heads });
}

function trim(store: LearnStore): LearnStore {
  const names = Object.keys(store.heads);
  if (names.length <= LEARN_MAX_HEADS) return store;
  const kept = names.sort((a, b) => store.heads[b].at - store.heads[a].at).slice(0, LEARN_MAX_HEADS);
  return { tick: store.tick, heads: Object.fromEntries(kept.map((name) => [name, store.heads[name]])) };
}

/** Значения по умолчанию для разбора (`ctx.learned`): только правки, набравшие порог. */
export function learnedDefaults(store: LearnStore): QuickLearned {
  const result: QuickLearned = {};
  Object.entries(store.heads).forEach(([head, { kind, minutes }]) => {
    const learnedKind = kind && kind.count >= LEARN_THRESHOLD ? kind.value : undefined;
    const learnedMinutes = minutes && minutes.count >= LEARN_THRESHOLD ? minutes.value : undefined;
    if (learnedKind || learnedMinutes) result[head] = { kind: learnedKind, minutes: learnedMinutes };
  });
  return result;
}

export function serializeLearned(store: LearnStore) {
  return JSON.stringify({ v: STORE_VERSION, tick: store.tick, heads: store.heads });
}

function parseCounted<T>(saved: unknown, isValid: (value: unknown) => value is T): Counted<T> | undefined {
  if (!saved || typeof saved !== 'object') return undefined;
  const { value, count } = saved as Record<string, unknown>;
  if (!isValid(value) || !Number.isInteger(count) || (count as number) < 1) return undefined;
  return { value, count: Math.min(count as number, LEARN_MAX_COUNT) };
}

function isMinutes(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= MINUTES_IN_DAY;
}

/** Словарь из строки хранилища; испорченное и незнакомое пропускается. */
export function parseLearned(saved: string | undefined): LearnStore {
  const store = createLearnStore();
  if (!saved) return store;
  let data: unknown;
  try {
    data = JSON.parse(saved);
  } catch (err) {
    return store;
  }
  if (!data || typeof data !== 'object') return store;
  const { v, tick, heads } = data as Record<string, unknown>;
  if (v !== STORE_VERSION || !heads || typeof heads !== 'object') return store;
  Object.entries(heads as Record<string, unknown>).forEach(([head, entry]) => {
    if (!head || head.length > MAX_HEAD_LENGTH || !entry || typeof entry !== 'object') return;
    const raw = entry as Record<string, unknown>;
    const kind = parseCounted(raw.kind, isLearnedKind);
    const minutes = parseCounted(raw.minutes, isMinutes);
    if (!kind && !minutes) return;
    store.heads[head] = { kind, minutes, at: Number.isInteger(raw.at) ? raw.at as number : 0 };
  });
  const lastAt = Math.max(0, ...Object.values(store.heads).map(({ at }) => at));
  store.tick = Math.max(Number.isInteger(tick) ? tick as number : 0, lastAt);
  return trim(store);
}

function storageKey(userId?: string) {
  return `${KEY_PREFIX}${userId || 'local'}`;
}

// Хранилище может быть недоступно — тогда словарь пуст и не запоминается
export function readLearned(userId?: string): LearnStore {
  try {
    return parseLearned(localStorage.getItem(storageKey(userId)) || undefined);
  } catch (err) {
    return createLearnStore();
  }
}

export function saveLearned(userId: string | undefined, store: LearnStore) {
  try {
    localStorage.setItem(storageKey(userId), serializeLearned(store));
  } catch (err) {
    // Правка просто не запомнится
  }
}

export function resetLearned(userId?: string) {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch (err) {
    // Сбрасывать нечего
  }
}
