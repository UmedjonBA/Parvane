import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import type { QuickContext } from './plannerQuick';
import type { LearnStore } from './plannerQuickLearn';

import { parseQuickInput } from './plannerQuick';
import {
  createLearnStore, LEARN_MAX_COUNT, LEARN_MAX_HEADS, LEARN_THRESHOLD, learnedDefaults, parseLearned,
  readLearned, recordCorrection, resetLearned, saveLearned, serializeLearned,
} from './plannerQuickLearn';

const CTX: QuickContext = {
  today: '2026-10-08', nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};

// Добавить строку так, как это делает окно: `user` — выбор пользователя (тип, снятые чипы)
function add(store: LearnStore, text: string, user?: Partial<QuickContext>) {
  const auto = parseQuickInput(text, CTX);
  const final = parseQuickInput(text, { ...CTX, learned: learnedDefaults(store), ...user });
  return recordCorrection(store, auto, final);
}

function addTimes(store: LearnStore, times: number, text: string, user?: Partial<QuickContext>) {
  let next = store;
  for (let i = 0; i < times; i++) next = add(next, text, user);
  return next;
}

describe('словарь правок: длительность', () => {
  it('одна и та же правка три раза становится значением по умолчанию', () => {
    let store = addTimes(createLearnStore(), LEARN_THRESHOLD - 1, 'летучка завтра 10:00 20 мин');
    expect(store.heads['летучка'].minutes).toEqual({ value: 20, count: 2 });
    expect(learnedDefaults(store)).toEqual({});
    expect(parseQuickInput('летучка завтра 11:00', { ...CTX, learned: learnedDefaults(store) }).end).toBe('12:00');
    // Третья правка — диапазоном и с заглавной буквы: то же слово, та же длительность
    store = add(store, 'Летучка отдела пт 15:00-15:20');
    expect(learnedDefaults(store)).toEqual({ летучка: { kind: undefined, minutes: 20 } });
    const fourth = parseQuickInput('летучка завтра 11:00', { ...CTX, learned: learnedDefaults(store) });
    expect(fourth).toMatchObject({ start: '11:00', end: '11:20', learned: ['minutes'] });
  });

  it('принятое выученное значение и запись без правки словарь не меняют', () => {
    const learned = addTimes(createLearnStore(), LEARN_THRESHOLD, 'летучка завтра 10:00 20 мин');
    expect(add(learned, 'летучка завтра 11:00')).toBe(learned);
    const empty = createLearnStore();
    expect(add(empty, 'летучка завтра 11:00')).toBe(empty);
    // Названная длительность равна обычной — править нечего
    expect(add(empty, 'летучка завтра 11:00 1 ч')).toBe(empty);
    expect(add(empty, 'пара завтра 9:00 1 ч 45 мин')).toBe(empty);
    // Задача, запись без названия, еда — не правки
    expect(add(empty, 'задача летучка завтра 11:00 20 мин')).toBe(empty);
    expect(add(empty, 'завтра 11:00 20 мин')).toBe(empty);
    expect(add(empty, 'обед 520 ккал')).toBe(empty);
  });

  it('повтор правки растит счётчик до потолка', () => {
    const store = addTimes(createLearnStore(), LEARN_MAX_COUNT + 3, 'летучка завтра 10:00 20 мин');
    expect(store.heads['летучка'].minutes).toEqual({ value: 20, count: LEARN_MAX_COUNT });
  });

  it('правка в другую сторону уменьшает счётчик, на нуле значение заменяется', () => {
    let store = addTimes(createLearnStore(), LEARN_THRESHOLD, 'летучка завтра 10:00 20 мин');
    store = add(store, 'летучка завтра 10:00 40 мин');
    expect(store.heads['летучка'].minutes).toEqual({ value: 20, count: 2 });
    expect(learnedDefaults(store)).toEqual({});
    store = add(store, 'летучка завтра 10:00 40 мин');
    expect(store.heads['летучка'].minutes).toEqual({ value: 20, count: 1 });
    store = add(store, 'летучка завтра 10:00 40 мин');
    expect(store.heads['летучка'].minutes).toEqual({ value: 40, count: 1 });
    // Названная обычная длительность тоже правка в другую сторону; на нуле слово забывается
    store = add(store, 'летучка завтра 10:00 60 мин');
    expect(store.heads['летучка']).toBeUndefined();
  });

  it('снятый чип выученной длительности уменьшает счётчик', () => {
    const learned = addTimes(createLearnStore(), LEARN_THRESHOLD, 'летучка завтра 10:00 20 мин');
    const store = add(learned, 'летучка завтра 11:00', { skip: ['minutes'] });
    expect(store.heads['летучка'].minutes).toEqual({ value: 20, count: LEARN_THRESHOLD - 1 });
    // Пока значение не выучено, запись без длительности ничего не значит
    expect(add(store, 'летучка завтра 11:00')).toBe(store);
  });

  it('обычная длительность слова — основа: «пара» учится от 1 ч 45 мин', () => {
    const store = addTimes(createLearnStore(), LEARN_THRESHOLD, 'пара завтра 9:00 1,5 ч');
    expect(learnedDefaults(store)).toEqual({ пара: { kind: undefined, minutes: 90 } });
    expect(parseQuickInput('пара вт 15:00', { ...CTX, learned: learnedDefaults(store) }).end).toBe('16:30');
  });
});

describe('словарь правок: тип', () => {
  it('переключение типа три раза становится типом по умолчанию', () => {
    let store = addTimes(createLearnStore(), LEARN_THRESHOLD - 1, 'купить хлеб 18:00', { kind: 'task' });
    expect(learnedDefaults(store)).toEqual({});
    store = add(store, 'Купить сыр завтра 19:00', { kind: 'task' });
    expect(learnedDefaults(store)).toEqual({ купить: { kind: 'task', minutes: undefined } });
    const fourth = parseQuickInput('купить молоко 18:00', { ...CTX, learned: learnedDefaults(store) });
    expect(fourth).toMatchObject({ kind: 'task', start: '18:00', learned: ['kind'] });
    // Принятый выученный тип и строка, где разбор и сам выбрал бы его, словарь не меняют
    expect(add(store, 'купить молоко 18:00')).toBe(store);
    expect(add(store, 'купить молоко')).toBe(store);
  });

  it('событие без времени: «др» учится как событие', () => {
    const store = addTimes(createLearnStore(), LEARN_THRESHOLD, 'др Маши завтра', { kind: 'event' });
    expect(parseQuickInput('др Пети 20.10', { ...CTX, learned: learnedDefaults(store) })).toMatchObject({
      kind: 'event', isAllDay: true, day: '2026-10-20', learned: ['kind'],
    });
  });

  it('выбор разбора, слово-тип в строке и тип еды — не правки', () => {
    const empty = createLearnStore();
    expect(add(empty, 'купить хлеб 18:00', { kind: 'event' })).toBe(empty);
    expect(add(empty, 'задача купить хлеб 18:00')).toBe(empty);
    expect(add(empty, 'купить хлеб 18:00', { kind: 'food' })).toBe(empty);
  });

  it('снятый чип и обратное переключение уменьшают счётчик', () => {
    const learned = addTimes(createLearnStore(), LEARN_THRESHOLD, 'купить хлеб 18:00', { kind: 'task' });
    let store = add(learned, 'купить хлеб 18:00', { skip: ['kind'] });
    expect(store.heads['купить'].kind).toEqual({ value: 'task', count: 2 });
    // Не выучено: событие без участия пользователя ничего не значит
    expect(add(store, 'купить хлеб 18:00')).toBe(store);
    store = add(learned, 'купить хлеб 18:00', { kind: 'event' });
    expect(store.heads['купить'].kind).toEqual({ value: 'task', count: 2 });
    // Обратная правка там, где разбор сам выбрал бы выученное
    store = add(learned, 'купить хлеб', { kind: 'event' });
    expect(store.heads['купить'].kind).toEqual({ value: 'task', count: 2 });
  });

  it('тип и длительность одного слова учатся отдельно', () => {
    let store = addTimes(createLearnStore(), LEARN_THRESHOLD, 'летучка завтра 10:00 20 мин');
    store = addTimes(store, LEARN_THRESHOLD, 'летучка завтра', { kind: 'event' });
    expect(learnedDefaults(store)).toEqual({ летучка: { kind: 'event', minutes: 20 } });
    store = addTimes(store, LEARN_THRESHOLD, 'летучка завтра 10:00 1 ч');
    expect(learnedDefaults(store)).toEqual({ летучка: { kind: 'event', minutes: undefined } });
  });

  it('слово с именем свойства объекта — обычное слово', () => {
    const store = addTimes(createLearnStore(), LEARN_THRESHOLD, 'constructor tomorrow 10:00 20 min', { lang: 'en' });
    expect(learnedDefaults(store)).toEqual({ constructor: { kind: undefined, minutes: 20 } });
    expect(Object.keys(store.heads)).toEqual(['constructor']);
  });
});

describe('словарь правок: хранение', () => {
  it('строка хранилища читается обратно', () => {
    let store = addTimes(createLearnStore(), LEARN_THRESHOLD, 'летучка завтра 10:00 20 мин');
    store = add(store, 'купить хлеб 18:00', { kind: 'task' });
    expect(parseLearned(serializeLearned(store))).toEqual(JSON.parse(JSON.stringify(store)));
  });

  it('испорченное и незнакомое пропускается', () => {
    const empty = createLearnStore();
    [undefined, '', 'not json', 'null', '[]', '{"v":2,"heads":{}}', '{"v":1}', '{"v":1,"heads":7}'].forEach((saved) => {
      expect(parseLearned(saved), String(saved)).toEqual(empty);
    });
    const saved = JSON.stringify({
      v: 1,
      tick: 'x',
      heads: {
        ok: { minutes: { value: 20, count: 99 }, kind: { value: 'food', count: 2 }, at: 7 },
        zero: { minutes: { value: 0, count: 1 } },
        fraction: { minutes: { value: 20, count: 1.5 } },
        empty: {},
        text: 'x',
        [`long${'g'.repeat(80)}`]: { minutes: { value: 20, count: 1 } },
      },
    });
    expect(parseLearned(saved)).toEqual({
      tick: 7, heads: { ok: { minutes: { value: 20, count: LEARN_MAX_COUNT }, kind: undefined, at: 7 } },
    });
  });

  it('помнит не больше предела слов: дольше всех не тронутые вытесняются', () => {
    let store = createLearnStore();
    for (let i = 0; i < LEARN_MAX_HEADS + 5; i++) {
      // Первые слова — буквами: цифры в слово не входят
      const head = `слово${[...String(i)].map((digit) => 'абвгдежзик'[Number(digit)]).join('')}`;
      store = add(store, `${head} завтра 10:00 20 мин`);
      // Самое первое слово трогается снова и потому остаётся
      if (i === 100) store = add(store, 'словоа завтра 10:00 20 мин');
    }
    const heads = Object.keys(store.heads);
    expect(heads).toHaveLength(LEARN_MAX_HEADS);
    expect(heads).toContain('словоа');
    expect(heads).not.toContain('словоб');
    expect(heads).toContain('слововад');
    expect(parseLearned(serializeLearned(store)).tick).toBe(store.tick);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('словарь у каждого аккаунта свой; сброс его очищает', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null, // eslint-disable-line no-null/no-null
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    });
    const store = addTimes(createLearnStore(), LEARN_THRESHOLD, 'летучка завтра 10:00 20 мин');
    saveLearned('user-a', store);
    expect(learnedDefaults(readLearned('user-a'))).toEqual({ летучка: { kind: undefined, minutes: 20 } });
    expect(readLearned('user-b')).toEqual(createLearnStore());
    expect(localStorage.getItem('parvane:quick-learned:user-a')).toBe(serializeLearned(store));
    resetLearned('user-a');
    expect(readLearned('user-a')).toEqual(createLearnStore());
    saveLearned(undefined, store);
    expect([...saved.keys()]).toEqual(['parvane:quick-learned:local']);
    resetLearned(undefined);
    expect(saved.size).toBe(0);
  });

  it('недоступное хранилище — пустой словарь без ошибок', () => {
    const fail = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: fail, setItem: fail, removeItem: fail });
    expect(readLearned('user-a')).toEqual(createLearnStore());
    expect(() => saveLearned('user-a', createLearnStore())).not.toThrow();
    expect(() => resetLearned('user-a')).not.toThrow();
  });
});
