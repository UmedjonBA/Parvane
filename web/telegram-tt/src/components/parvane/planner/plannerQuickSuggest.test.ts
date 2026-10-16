import { describe, expect, it } from 'vitest';

import type { PlannerEvent, PlannerRepeat, PlannerTask } from './plannerModel';
import type { QuickContext } from './plannerQuick';
import type {
  QuickCandidate, QuickHistory, QuickLineDraft, QuickSuggestSources,
} from './plannerQuickSuggest';

import { parseQuickInput } from './plannerQuick';
import {
  buildCandidates, buildSuggestions, createQuickHistory, draftToLine, filterSuggestions, forgetQuickLine,
  forgetSuggestion, hasHistory, HISTORY_MAX_HIDDEN, HISTORY_MAX_LINES, historyFromLines, historyToLines,
  isSuggestionPrefix, lineKey, MAX_SUGGESTIONS, mergeHistories, parseHistory, quickLineId, recordHistoryLine,
  recordQuickLine, serializeHistory,
} from './plannerQuickSuggest';

// 8 октября 2026 — четверг, полдень; окно дня 09:00–21:00
const CTX: QuickContext = {
  today: '2026-10-08', nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60, lang: 'ru',
};
const EN: QuickContext = { ...CTX, lang: 'en' };
const EXAMPLES = ['созвон завтра 16:00 45 мин', 'задача проверить работы до пт', 'вода 500 мл'];

const weekly = (weekdays: number[], interval = 1) => ({ kind: 'weekly', interval, weekdays } as const);
const every = (kind: PlannerRepeat['kind'], interval = 1) => ({ kind, interval });

function history(...lines: string[]): QuickHistory {
  return lines.reduce((store, line) => (
    recordHistoryLine(store, line, lineKey(line, parseQuickInput(line, CTX), 'ru'))
  ), createQuickHistory());
}

function sources(patch: Partial<QuickSuggestSources> = {}): QuickSuggestSources {
  return {
    history: createQuickHistory(), tasks: [], events: [], examples: EXAMPLES, ...patch,
  };
}

let nextId = 0;

function task(name: string, patch: Partial<PlannerTask> = {}): PlannerTask {
  nextId += 1;
  return {
    id: `t${nextId}`, name, description: '', steps: [], status: 'queue', project: '', rank: -nextId, ...patch,
  };
}

function event(name: string, start: string, end: string, patch: Partial<PlannerEvent> = {}): PlannerEvent {
  nextId += 1;
  return {
    id: `e${nextId}`, name, start, end, day: '2026-10-05', ...patch,
  };
}

const texts = (list: { text: string }[]) => list.map(({ text }) => text);

describe('строка из записи: разбор наоборот', () => {
  type Row = [draft: QuickLineDraft, line: string];

  const RU: Row[] = [
    [{
      kind: 'event', name: 'ОГЭ по информатике', start: '18:30', end: '20:15', repeat: weekly([1]),
    }, 'ОГЭ по информатике пн 18:30 1 ч 45 мин каждую неделю'],
    // Обычная длительность первого слова не пишется
    [{
      kind: 'event', name: 'созвон', start: '16:00', end: '16:30',
    }, 'созвон 16:00'],
    [{
      kind: 'event', name: 'пара по английскому', start: '15:00', end: '16:45',
    }, 'пара по английскому 15:00'],
    [{
      kind: 'event', name: 'доклад', start: '16:00', end: '16:45',
    }, 'доклад 16:00 45 мин'],
    [{
      kind: 'event', name: 'Защита диплома', start: '10:00', end: '13:00',
    }, 'Защита диплома 10:00 3 ч'],
    [{ kind: 'task', name: 'купить хлеб' }, 'купить хлеб'],
    [{ kind: 'task', name: 'купить краску', list: 'Ремонт' }, 'купить краску #Ремонт'],
    [{ kind: 'task', name: 'заказать плитку', list: 'Ремонт кухни' }, 'заказать плитку #Ремонт_кухни'],
    // Тип, который разбор сам не выбрал бы, назван словом
    [{
      kind: 'task', name: 'разбор почты', start: '18:00', minutes: 30,
    }, 'задача разбор почты 18:00'],
    [{
      kind: 'task', name: 'разбор почты', start: '18:00', minutes: 50,
    }, 'задача разбор почты 18:00 50 мин'],
    [{ kind: 'task', name: 'проверить работы', minutes: 90 }, 'проверить работы 1 ч 30 мин'],
    [{ kind: 'event', name: 'педсовет', isAllDay: true }, 'событие педсовет'],
    [{
      kind: 'event', name: 'зарядка', start: '07:30', end: '07:45', repeat: every('daily'),
    }, 'зарядка 07:30 15 мин каждый день'],
    [{
      kind: 'event', name: 'хор', start: '19:00', end: '20:00', repeat: weekly([3, 1]),
    }, 'хор по пн, ср 19:00'],
    [{
      kind: 'event', name: 'планёрка', start: '09:30', end: '10:30', repeat: weekly([1, 2, 3, 4, 5]),
    }, 'планёрка по будням 09:30'],
    [{
      kind: 'task', name: 'уборка', repeat: weekly([0, 6]),
    }, 'уборка по выходным'],
    [{
      kind: 'event', name: 'семинар', start: '12:00', end: '13:00', repeat: weekly([5], 2),
    }, 'семинар пт 12:00 каждые 2 недели'],
    [{
      kind: 'event', name: 'хор', start: '19:00', end: '20:00', repeat: weekly([1, 3], 2),
    }, 'хор по пн, ср 19:00 каждые 2 недели'],
    [{ kind: 'task', name: 'оплатить интернет', repeat: every('monthly') }, 'оплатить интернет каждый месяц'],
    [{ kind: 'task', name: 'полить цветы', repeat: every('daily', 3) }, 'полить цветы каждые 3 дня'],
    [{ kind: 'task', name: 'проверить счётчики', repeat: every('monthly', 5) }, 'проверить счётчики каждые 5 месяцев'],
    [{
      kind: 'event', name: 'техосмотр', isAllDay: true, repeat: every('yearly'),
    }, 'событие техосмотр каждый год'],
  ];

  const ENGLISH: Row[] = [
    [{
      kind: 'event', name: 'Math exam prep', start: '18:30', end: '20:15', repeat: weekly([1]),
    }, 'Math exam prep mon 18:30 1 h 45 min every week'],
    [{
      kind: 'event', name: 'call', start: '16:00', end: '16:30',
    }, 'call 16:00'],
    [{
      kind: 'event', name: 'Design review', start: '16:00', end: '16:45',
    }, 'Design review 16:00 45 min'],
    [{ kind: 'task', name: 'buy bread' }, 'buy bread'],
    [{ kind: 'task', name: 'paint the wall', list: 'Home repair' }, 'paint the wall #Home_repair'],
    [{
      kind: 'task', name: 'review inbox', start: '18:00', minutes: 30,
    }, 'task review inbox 18:00'],
    [{ kind: 'task', name: 'grade papers', minutes: 90 }, 'grade papers 1 h 30 min'],
    [{ kind: 'event', name: 'team offsite', isAllDay: true }, 'event team offsite'],
    [{
      kind: 'event', name: 'Standup', start: '10:00', end: '10:15', repeat: weekly([1, 2, 3, 4, 5]),
    }, 'Standup on weekdays 10:00'],
    [{
      kind: 'event', name: 'piano', start: '17:00', end: '18:00', repeat: weekly([2, 4]),
    }, 'piano on tue, thu 17:00'],
    [{
      kind: 'event', name: 'retro', start: '15:00', end: '16:00', repeat: weekly([5], 2),
    }, 'retro fri 15:00 every 2 weeks'],
    [{ kind: 'task', name: 'feed the cat', repeat: every('daily', 3) }, 'feed the cat every 3 days'],
    [{ kind: 'task', name: 'pay rent', repeat: every('monthly') }, 'pay rent every month'],
    [{
      kind: 'event', name: 'stretching', start: '07:30', end: '07:45', repeat: every('daily'),
    }, 'stretching 07:30 15 min every day'],
  ];

  function check(rows: Row[], ctx: QuickContext) {
    rows.forEach(([draft, line]) => {
      it(line, () => {
        expect(draftToLine(draft, ctx.lang!)).toBe(line);
        // Обычная и полная запись читаются разбором как та же запись
        [line, draftToLine(draft, ctx.lang!, true)].forEach((text) => {
          const parsed = parseQuickInput(text, ctx);
          expect(parsed.error, text).toBeUndefined();
          expect(parsed, text).toMatchObject({ kind: draft.kind, name: draft.name });
          expect(parsed.list, text).toBe(draft.list);
          expect(Boolean(parsed.isAllDay), text).toBe(Boolean(draft.isAllDay));
          if (!draft.isAllDay) expect(parsed.start, text).toBe(draft.start);
          if (draft.kind === 'event' && !draft.isAllDay) expect(parsed.end, text).toBe(draft.end);
          if (draft.kind === 'task') expect(parsed.minutes, text).toBe(draft.minutes);
          if (draft.repeat) {
            expect(parsed.repeat, text).toMatchObject({ kind: draft.repeat.kind, interval: draft.repeat.interval });
            if (draft.repeat.weekdays) {
              expect(parsed.repeat!.weekdays, text).toEqual([...draft.repeat.weekdays].sort((a, b) => a - b));
            }
            expect(parsed.repeat!.endDay, text).toBeUndefined();
          } else {
            expect(parsed.repeat, text).toBeUndefined();
            // Дата в строку не пишется: день либо не назван, либо подставлен разбором
            expect(!parsed.day || parsed.isDayAssumed, text).toBe(true);
          }
        });
      });
    });
  }

  describe('русский', () => check(RU, CTX));
  describe('английский', () => check(ENGLISH, EN));

  it('полная запись называет тип, длительность и один день недели словами повтора', () => {
    expect(draftToLine({
      kind: 'event', name: 'созвон', start: '16:00', end: '16:30', repeat: weekly([1]),
    }, 'ru', true)).toBe('событие созвон по пн 16:00 30 мин');
    expect(draftToLine({
      kind: 'event', name: 'call', start: '16:00', end: '16:30', repeat: weekly([1]),
    }, 'en', true)).toBe('event call every mon 16:00 30 min');
  });

  it('негодное в метку название группы не пишется; группа события — меткой', () => {
    expect(draftToLine({ kind: 'task', name: 'купить кабель', list: '1-й этаж' }, 'ru')).toBe('купить кабель');
    expect(draftToLine({ kind: 'event', name: 'педсовет', isAllDay: true, list: 'Школа' }, 'ru'))
      .toBe('событие педсовет #Школа');
  });
});

describe('подсказки: источники', () => {
  it('без истории и данных — встроенные примеры в своём порядке', () => {
    const list = buildSuggestions('', sources(), CTX);
    expect(list).toEqual(EXAMPLES.map((text) => ({ text, source: 'example' })));
  });

  it('набранные строки — дословно, свежие первыми, примеры добирают список', () => {
    const list = buildSuggestions('', sources({
      history: history('Созвон с Олей завтра 16:00', 'вес 72,4', 'купить  кабель'),
    }), CTX);
    expect(list).toEqual([
      { text: 'купить кабель', source: 'history' },
      { text: 'вес 72,4', source: 'history' },
      { text: 'Созвон с Олей завтра 16:00', source: 'history' },
      ...EXAMPLES.map((text) => ({ text, source: 'example' })),
    ]);
  });

  it('частая строка выше свежей', () => {
    const list = buildSuggestions('', sources({
      history: history('вода 250 мл', 'вода 250 мл', 'купить кабель'), examples: [],
    }), CTX);
    expect(texts(list)).toEqual(['вода 250 мл', 'купить кабель']);
  });

  it('строки одного шаблона, отличающиеся датой, — одна подсказка, самая свежая', () => {
    const list = buildSuggestions('', sources({
      history: history('летучка завтра 10:00 20 мин', 'купить кабель', 'летучка пт 10:00 20 мин'), examples: [],
    }), CTX);
    expect(texts(list)).toEqual(['летучка пт 10:00 20 мин', 'купить кабель']);
  });

  it('строка, которую разбор теперь читает с ошибкой, не предлагается', () => {
    const broken = { tick: 2, lines: [{ text: 'завтра 15:00', count: 5, at: 2 }], hidden: [] };
    expect(parseQuickInput('завтра 15:00', CTX).error).toBe('name');
    expect(buildSuggestions('', sources({ history: broken, examples: ['завтра 15:00', 'вода 500 мл'] }), CTX))
      .toEqual([{ text: 'вода 500 мл', source: 'example' }]);
  });

  it('записи «Плана» становятся строками без даты', () => {
    const list = buildSuggestions('', sources({
      tasks: [
        task('купить хлеб', { day: '2026-10-07' }), task('сдать отчёт', { due: '2026-10-09', project: 'Работа' }),
      ],
      events: [
        event('ОГЭ по информатике', '18:30', '20:15', {
          day: undefined,
          repeat: {
            kind: 'weekly', interval: 1, weekdays: [1], startDay: '2026-09-07', endDay: '2027-05-31',
          },
        }),
        event('созвон', '16:00', '16:30'),
      ],
      examples: [],
    }), CTX);
    expect(list).toEqual([
      { text: 'сдать отчёт #Работа', source: 'data' },
      { text: 'созвон 16:00', source: 'data' },
      { text: 'купить хлеб', source: 'data' },
      { text: 'ОГЭ по информатике пн 18:30 1 ч 45 мин каждую неделю', source: 'data' },
    ]);
  });

  it('повторяющаяся запись выше разовой, отделённый экземпляр ряда не считается', () => {
    const list = buildSuggestions('', sources({
      events: [
        event('созвон', '16:00', '16:30'),
        event('доклад', '12:00', '13:00'),
        event('Созвон', '16:00', '16:30', { day: '2026-10-06' }),
        event('доклад', '12:00', '13:00', { origin: { seriesId: 'x', day: '2026-10-01' } }),
      ],
      examples: [],
    }), CTX);
    expect(texts(list)).toEqual(['Созвон 16:00', 'доклад 12:00']);
  });

  it('запись, добавленная строкой истории, второй подсказки не даёт', () => {
    const list = buildSuggestions('', sources({
      history: history('созвон завтра 16:00'),
      events: [event('созвон', '16:00', '16:30'), event('созвон', '16:00', '16:30'), event('доклад', '12:00', '13:00')],
      examples: [],
    }), CTX);
    expect(list).toEqual([
      { text: 'созвон завтра 16:00', source: 'history' },
      { text: 'доклад 12:00', source: 'data' },
    ]);
  });

  it('название, которое разбор читает иначе, пишется полной записью либо не предлагается', () => {
    const tasks = [
      task('встреча в 5'), task('отчёт до пт'), task('обед 520 ккал'), task('вес 72'), task('Матан 2', {
        repeat: {
          kind: 'weekly', interval: 1, weekdays: [1], startDay: '2026-09-07',
        },
      }),
      task('купить молоко, хлеб'), task('позвонить — насчёт дачи'), task('первая строка\nвторая'),
    ];
    const events = [event('пара', '15:00', '16:00'), event('Физика пара', '10:00', '11:00')];
    const candidates = buildCandidates(sources({ tasks, events, examples: [] }), CTX);
    const names = [...tasks, ...events].map(({ name }) => name);
    candidates.forEach(({ text }) => {
      const parsed = parseQuickInput(text, CTX);
      expect(parsed.error, text).toBeUndefined();
      expect(names, text).toContain(parsed.name);
    });
    expect(texts(candidates)).toEqual(expect.arrayContaining([
      'купить молоко, хлеб', 'пара 15:00 1 ч', 'событие Физика пара 10:00 1 ч', 'задача Матан 2 по пн',
      'задача вес 72',
    ]));
    expect(texts(candidates).some((text) => text.includes('\n'))).toBe(false);
  });

  it('слова строки — на языке названия: русская запись при английском интерфейсе', () => {
    const list = buildSuggestions('', sources({
      events: [
        event('созвон', '16:00', '16:30'),
        event('Sync', '11:00', '12:00', { day: undefined, repeat: { ...weekly([2]), startDay: '2026-09-01' } }),
      ],
      examples: [],
    }), EN);
    expect(texts(list)).toEqual(['Sync tue 11:00 every week', 'созвон 16:00']);
  });

  it('выученный тип не меняет запись подсказки: тип назван словом', () => {
    const list = buildSuggestions('', sources({ events: [event('летучка', '10:00', '11:00')], examples: [] }), {
      ...CTX, learned: { летучка: { kind: 'task', minutes: 20 } },
    });
    expect(texts(list)).toEqual(['событие летучка 10:00 1 ч']);
  });
});

describe('подсказки: кэш разбора (C5)', () => {
  const base = sources({
    history: history('пара по английскому вт 15:00', 'купить ёлку', 'вес 72,4'),
    tasks: [task('написать Оле'), task('отчёт', { start: '10:00', minutes: 30 })],
    events: [event('Стендап', '09:30', '09:45')],
  });

  it('повторная сборка в том же контексте даёт то же; смена контекста кэш не путает', () => {
    const first = buildCandidates(base, CTX);
    expect(buildCandidates(base, CTX)).toEqual(first);
    const english = buildCandidates(base, EN);
    expect(buildCandidates(base, EN)).toEqual(english);
    expect(buildCandidates(base, CTX)).toEqual(first);
    // Другой день, тот же язык — свой разбор (относительные дни)
    const tomorrow = buildCandidates(base, { ...CTX, today: '2026-10-09' });
    expect(texts(tomorrow)).toEqual(texts(first));
    // Минута «сейчас» кандидатов не меняет
    expect(buildCandidates(base, { ...CTX, nowMinutes: 18 * 60 })).toEqual(first);
  });

  it('на больших данных повторная сборка заметно дешевле первой', () => {
    const big = sources({
      history: history(...Array.from({ length: 150 }, (_, i) => `дело номер ${i} завтра ${9 + (i % 10)}:00`)),
      tasks: Array.from({ length: 150 }, (_, i) => task(`задача ${i}`, { start: '10:00', minutes: 15 + i })),
      events: Array.from({ length: 150 }, (_, i) => event(`встреча ${i}`, '12:00', '13:00')),
    });
    const ctx = { ...CTX, today: '2026-10-10' };
    const startedCold = performance.now();
    const cold = buildCandidates(big, ctx);
    const coldMs = performance.now() - startedCold;
    const startedWarm = performance.now();
    const warm = buildCandidates(big, ctx);
    const warmMs = performance.now() - startedWarm;
    expect(warm).toEqual(cold);
    expect(cold.length).toBeGreaterThan(300);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] подсказки, 450 записей: первая сборка ${coldMs.toFixed(1)} мс, повторная ${warmMs.toFixed(1)} мс`,
    );
    expect(warmMs).toBeLessThan(Math.max(coldMs / 2, 5));
  });
});

describe('подсказки: набранное', () => {
  const candidates = buildCandidates(sources({
    history: history(
      'пара по английскому вт 15:00', 'купить ёлку', 'созвон с Олей завтра 16:00', 'английский язык 18:00',
      'вес 72,4', 'созвон с Олей завтра 16:00',
    ),
    tasks: [task('написать Оле')],
    examples: ['созвон завтра 16:00 45 мин', 'вода 500 мл'],
  }), CTX);
  const suggest = (input: string) => texts(filterSuggestions(input, candidates));

  it('пустая строка — свои по частоте и свежести, затем примеры', () => {
    expect(suggest('  ')).toEqual([
      'созвон с Олей завтра 16:00', 'вес 72,4', 'английский язык 18:00', 'купить ёлку',
      'пара по английскому вт 15:00', 'написать Оле', 'созвон завтра 16:00 45 мин', 'вода 500 мл',
    ]);
  });

  it('начало строки старше начала слова названия, оно — старше вхождения', () => {
    // «английский…» начинается с набранного, у «пары» с него начинается слово названия
    expect(suggest('анг')).toEqual(['английский язык 18:00', 'пара по английскому вт 15:00']);
    // «16» — начало слова строки, но не названия: вхождение
    expect(suggest('16')).toEqual(['созвон с Олей завтра 16:00', 'созвон завтра 16:00 45 мин']);
    expect(suggest('ол')).toEqual(['созвон с Олей завтра 16:00', 'написать Оле']);
  });

  it('при равном совпадении — чаще, затем свои прежде примеров', () => {
    expect(suggest('соз')).toEqual(['созвон с Олей завтра 16:00', 'созвон завтра 16:00 45 мин']);
  });

  it('регистр и «ё» не различаются', () => {
    expect(suggest('КУПИТЬ Е')).toEqual(['купить ёлку']);
    expect(suggest('ёлк')).toEqual(['купить ёлку']);
    expect(suggest('елку')).toEqual(['купить ёлку']);
  });

  it('прежние слова обязаны быть в строке, последнее — начало слова', () => {
    expect(suggest('созвон ол')).toEqual(['созвон с Олей завтра 16:00']);
    expect(suggest('созвон оле')).toEqual(['созвон с Олей завтра 16:00']);
    expect(suggest('созвон вас')).toEqual([]);
    // Слово дописано (пробел): «соз» — не слово строки
    expect(suggest('соз ')).toEqual([]);
    expect(suggest('созвон ')).toEqual(['созвон с Олей завтра 16:00', 'созвон завтра 16:00 45 мин']);
  });

  it('одна буква ищется только с начала слова', () => {
    expect(suggest('я')).toEqual(['английский язык 18:00']);
    expect(suggest('в')).toEqual(['вес 72,4', 'вода 500 мл', 'пара по английскому вт 15:00']);
  });

  it('строка, равная набранной, не предлагается', () => {
    expect(suggest('Купить елку ')).toEqual([]);
    expect(suggest('вес 72,4')).toEqual([]);
    expect(suggest('вес 72')).toEqual(['вес 72,4']);
  });

  it('ничего не подошло — список пуст, примеры не подставляются', () => {
    expect(suggest('стоматолог')).toEqual([]);
  });

  it('английская строка', () => {
    const english = buildCandidates(sources({
      history: {
        tick: 3,
        lines: [
          { text: 'Team sync tue 11:00', count: 1, at: 3 },
          { text: 'buy a synthesizer', count: 1, at: 2 },
          { text: 'weight 72.4', count: 1, at: 1 },
        ],
        hidden: [],
      },
      examples: ['call tomorrow 16:00 45 min'],
    }), EN);
    expect(texts(filterSuggestions('SY', english))).toEqual(['Team sync tue 11:00', 'buy a synthesizer']);
    expect(texts(filterSuggestions('team s', english))).toEqual(['Team sync tue 11:00']);
    expect(texts(filterSuggestions('w', english))).toEqual(['weight 72.4']);
    expect(texts(filterSuggestions('', english))).toEqual([
      'Team sync tue 11:00', 'buy a synthesizer', 'weight 72.4', 'call tomorrow 16:00 45 min',
    ]);
  });

  it('не больше восьми подсказок', () => {
    const many = history(...Array.from({ length: 30 }, (_, index) => `дело номер ${index + 1}`));
    const list = buildSuggestions('', sources({ history: many }), CTX);
    expect(list).toHaveLength(MAX_SUGGESTIONS);
    expect(list.every(({ source }) => source === 'history')).toBe(true);
    expect(buildSuggestions('дело', sources({ history: many }), CTX)).toHaveLength(MAX_SUGGESTIONS);
  });

  it('Tab принимает подсказку, только когда набрано её начало', () => {
    expect(isSuggestionPrefix('Купить е', 'купить ёлку')).toBe(true);
    expect(isSuggestionPrefix('  купить  ', 'купить ёлку')).toBe(true);
    expect(isSuggestionPrefix('купить ёлку', 'купить ёлку')).toBe(false);
    expect(isSuggestionPrefix('купить ёлку ', 'купить ёлку')).toBe(false);
    expect(isSuggestionPrefix('елку', 'купить ёлку')).toBe(false);
    expect(isSuggestionPrefix('', 'купить ёлку')).toBe(false);
  });

  it('фильтр по пятистам кандидатам укладывается в такт набора', () => {
    const big: QuickCandidate[] = Array.from({ length: 500 }, (_, index) => {
      const text = `совещание отдела номер ${index} по вторникам 1${index % 10}:30 1 ч 15 мин каждую неделю`;
      const words = text.split(/[^\p{L}\p{N}]+/u);
      return {
        text,
        source: 'history',
        key: text,
        line: text,
        words,
        nameWords: words.slice(0, 4),
        count: 1,
        at: index,
        texts: [],
      };
    });
    const input = 'совещание отдела номер 4 по вторникам 14:30 1 ч 15';
    expect(input.length).toBeGreaterThanOrEqual(50);
    const started = performance.now();
    for (let round = 0; round < 100; round++) filterSuggestions(input.slice(0, 1 + (round % input.length)), big);
    // Сто нажатий клавиш; на деле — единицы миллисекунд, граница с большим запасом
    expect(performance.now() - started).toBeLessThan(1000);
    expect(filterSuggestions(input, big)).toHaveLength(1);
  });
});

describe('подсказки: история и «Забыть»', () => {
  it('та же строка не дублируется: растёт счётчик, строка становится свежей', () => {
    const store = history('Купить кабель', 'вес 72,4', '  купить   КАБЕЛЬ ');
    expect(store.lines).toEqual([
      { text: 'купить КАБЕЛЬ', count: 2, at: 3 },
      { text: 'вес 72,4', count: 1, at: 2 },
    ]);
  });

  it('пустая и слишком длинная строка не запоминаются', () => {
    const store = createQuickHistory();
    expect(recordHistoryLine(store, '   ', '')).toBe(store);
    expect(recordHistoryLine(store, 'а'.repeat(301), 'x')).toBe(store);
  });

  it('помнит двести последних строк', () => {
    const store = history(...Array.from({ length: HISTORY_MAX_LINES + 20 }, (_, index) => `дело ${index}`));
    expect(store.lines).toHaveLength(HISTORY_MAX_LINES);
    expect(store.lines[0].text).toBe(`дело ${HISTORY_MAX_LINES + 19}`);
    expect(store.lines[HISTORY_MAX_LINES - 1].text).toBe('дело 20');
  });

  it('забытая строка истории уходит вместе со строками того же шаблона и не возвращается из данных', () => {
    const base = sources({
      history: history('летучка завтра 10:00 20 мин', 'купить кабель', 'летучка пт 10:00 20 мин'),
      events: [event('летучка', '10:00', '10:20')],
      tasks: [task('купить кабель')],
      examples: [],
    });
    const target = buildCandidates(base, CTX).find(({ text }) => text === 'летучка пт 10:00 20 мин')!;
    expect(target.texts).toEqual(['летучка пт 10:00 20 мин', 'летучка завтра 10:00 20 мин']);
    const forgotten = forgetSuggestion(base.history, target);
    expect(texts(forgotten.lines)).toEqual(['купить кабель']);
    expect(texts(buildSuggestions('', { ...base, history: forgotten }, CTX))).toEqual(['купить кабель']);
    // Добавленная снова строка перестаёт быть забытой
    const line = 'летучка 10:00 20 мин';
    const again = recordHistoryLine(forgotten, line, lineKey(line, parseQuickInput(line, CTX), 'ru'));
    expect(again.hidden).toEqual([]);
    expect(texts(buildSuggestions('', { ...base, history: again }, CTX))).toEqual([line, 'купить кабель']);
  });

  it('забытая подсказка из данных «Плана» скрывается на устройстве', () => {
    const base = sources({ tasks: [task('купить хлеб'), task('купить кабель')], examples: [] });
    const [first] = buildCandidates(base, CTX);
    expect(first).toMatchObject({ text: 'купить кабель', source: 'data', texts: [] });
    const forgotten = forgetSuggestion(base.history, first);
    expect(forgotten.hidden).toEqual(['купить кабель']);
    expect(texts(buildSuggestions('', { ...base, history: forgotten }, CTX))).toEqual(['купить хлеб']);
  });

  it('список забытого ограничен', () => {
    let store = createQuickHistory();
    for (let index = 0; index < HISTORY_MAX_HIDDEN + 10; index++) {
      store = forgetSuggestion(store, { key: `дело ${index}`, texts: [] });
    }
    expect(store.hidden).toHaveLength(HISTORY_MAX_HIDDEN);
    expect(store.hidden[0]).toBe(`дело ${HISTORY_MAX_HIDDEN + 9}`);
  });

  it('переживает запись в хранилище', () => {
    const store = forgetSuggestion(history('купить кабель', 'вес 72,4', 'купить кабель'), { key: 'созвон', texts: [] });
    expect(parseHistory(serializeHistory(store))).toEqual(store);
  });

  it('испорченная и незнакомая запись хранилища — пустая история', () => {
    const empty = createQuickHistory();
    expect(parseHistory(undefined)).toEqual(empty);
    expect(parseHistory('{')).toEqual(empty);
    expect(parseHistory('[]')).toEqual(empty);
    expect(parseHistory(JSON.stringify({ v: 2, lines: [{ text: 'дело', count: 1, at: 1 }] }))).toEqual(empty);
    expect(parseHistory(JSON.stringify({
      v: 1,
      tick: 'x',
      lines: [
        { text: ' дело  раз ', count: -3, at: 4 }, { text: 'ДЕЛО РАЗ', count: 2, at: 9 }, { text: 5 }, 'строка',
        { text: 'дело два', count: 2 },
      ],
      hidden: ['дело', 7],
    }))).toEqual({
      tick: 4,
      lines: [{ text: 'дело раз', count: 1, at: 4 }, { text: 'дело два', count: 2, at: 0 }],
      hidden: ['дело'],
    });
  });
});

describe('подсказки: история в данных «Плана»', () => {
  const key = (line: string) => lineKey(line, parseQuickInput(line, CTX), 'ru');

  it('ключ записи — по строке без регистра и лишних пробелов, только латиница и цифры', () => {
    expect(quickLineId('Купить  кабель')).toBe(quickLineId(' купить КАБЕЛЬ'));
    expect(quickLineId('ёлка')).toBe(quickLineId('елка'));
    expect(quickLineId('купить кабель')).not.toBe(quickLineId('купить кабели'));
    // Строка и забытый шаблон с тем же текстом — разные записи
    expect(quickLineId('созвон', true)).not.toBe(quickLineId('созвон'));
    expect(quickLineId('купить кабель')).toMatch(/^q[0-9a-f]{16}$/);
    expect(quickLineId('созвон', true)).toMatch(/^h[0-9a-f]{16}$/);
    // Ключ одинаков на всех устройствах: значение закреплено
    expect(quickLineId('созвон завтра 16:00')).toBe('q84f71769879cc437');
  });

  it('история проходит через записи «Плана» без потерь', () => {
    const store = forgetSuggestion(history('купить кабель', 'вес 72,4', 'Купить кабель'), { key: 'созвон', texts: [] });
    const lines = historyToLines(store);
    expect(lines).toHaveLength(3);
    expect(lines.find(({ text }) => text === 'Купить кабель')).toEqual({
      id: quickLineId('купить кабель'), text: 'Купить кабель', count: 2, touched: 3,
    });
    expect(lines.find(({ isHidden }) => isHidden)).toEqual({
      id: quickLineId('созвон', true), text: 'созвон', count: 0, touched: 3, isHidden: true,
    });
    expect(historyFromLines(lines)).toEqual(store);
    // Повторный проход записи не меняет: движку уходит только изменившееся
    expect(historyToLines(historyFromLines(lines), lines)).toEqual(lines);
  });

  it('добавленная строка меняет одну запись, вытесненная сотней новых — уходит', () => {
    const lines = historyToLines(history('купить кабель', 'вес 72,4'));
    const next = recordQuickLine(lines, createQuickHistory(), 'купить КАБЕЛЬ', key('купить кабель'));
    expect(next.filter((line) => !lines.some((before) => JSON.stringify(before) === JSON.stringify(line)))).toEqual([{
      id: quickLineId('купить кабель'), text: 'купить КАБЕЛЬ', count: 2, touched: 3,
    }]);
    expect(next).toHaveLength(2);
    const full = historyToLines(history(
      ...Array.from({ length: HISTORY_MAX_LINES }, (_, index) => `дело ${index}`),
    ));
    const pushed = recordQuickLine(full, createQuickHistory(), 'новое дело', key('новое дело'));
    expect(pushed).toHaveLength(HISTORY_MAX_LINES);
    expect(pushed.some(({ text }) => text === 'дело 0')).toBe(false);
    expect(pushed.some(({ text }) => text === 'новое дело')).toBe(true);
  });

  it('«Забыть» убирает строки подсказки и помечает шаблон; добавленная снова строка снимает пометку', () => {
    const lines = historyToLines(history('летучка завтра 10:00 20 мин', 'купить кабель', 'летучка пт 10:00 20 мин'));
    const template = key('летучка пт 10:00 20 мин');
    const forgotten = forgetQuickLine(lines, createQuickHistory(), {
      key: template, texts: ['летучка пт 10:00 20 мин', 'летучка завтра 10:00 20 мин'],
    });
    expect(forgotten.map(({ text, isHidden }) => [text, Boolean(isHidden)]).sort()).toEqual([
      ['купить кабель', false], [template, true],
    ]);
    // Свежесть забытого шаблона при следующих правках не меняется
    const later = recordQuickLine(forgotten, createQuickHistory(), 'вес 72,4', key('вес 72,4'));
    const hiddenOf = (list: typeof lines) => list.find(({ isHidden }) => isHidden);
    expect(hiddenOf(later)).toEqual(hiddenOf(forgotten));
    const again = recordQuickLine(later, createQuickHistory(), 'летучка 10:00 20 мин', template);
    expect(hiddenOf(again)).toBeUndefined();
    expect(again.map(({ text }) => text).sort()).toEqual(['вес 72,4', 'купить кабель', 'летучка 10:00 20 мин']);
  });

  it('запись устройства вливается: общая строка не складывается, своя становится самой свежей', () => {
    const synced = historyFromLines([
      {
        id: quickLineId('купить кабель'), text: 'купить кабель', count: 5, touched: 40,
      },
      {
        id: quickLineId('вес 72,4'), text: 'вес 72,4', count: 1, touched: 41,
      },
      {
        id: quickLineId('созвон', true), text: 'созвон', count: 0, touched: 12, isHidden: true,
      },
    ]);
    const local = forgetSuggestion(history('Купить кабель', 'зал 19:00', 'пробежка 5 км'), { key: 'обед', texts: [] });
    const merged = mergeHistories(synced, local);
    expect(merged).toEqual({
      tick: 43,
      lines: [
        { text: 'пробежка 5 км', count: 1, at: 43 },
        { text: 'зал 19:00', count: 1, at: 42 },
        { text: 'вес 72,4', count: 1, at: 41 },
        { text: 'купить кабель', count: 5, at: 40 },
      ],
      hidden: ['созвон', 'обед'],
    });
    expect(mergeHistories(synced, createQuickHistory())).toBe(synced);
    expect(hasHistory(local)).toBe(true);
    expect(hasHistory(createQuickHistory())).toBe(false);
  });

  it('негодное движку в записи не попадает, чужие записи читаются терпимо', () => {
    const store: QuickHistory = {
      tick: 2,
      lines: [{ text: 'дело\u0007 со звонком', count: 1, at: 2 }, { text: 'дело', count: 1, at: 1 }],
      hidden: ['ключ\u0000'],
    };
    expect(historyToLines(store).map(({ text }) => text)).toEqual(['дело']);
    // Две записи одной строки (ключ выбран другим клиентом), пустой текст и нулевой счётчик
    expect(historyFromLines([
      {
        id: 'other', text: ' Дело ', count: 0, touched: 7,
      },
      {
        id: quickLineId('дело'), text: 'дело', count: 3, touched: 5,
      },
      {
        id: 'empty', text: '   ', count: 1, touched: 9,
      },
    ])).toEqual({ tick: 9, lines: [{ text: 'Дело', count: 1, at: 7 }], hidden: [] });
  });
});
