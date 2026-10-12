import { describe, expect, it } from 'vitest';

import type { PlannerEvent, PlannerState, PlannerTask } from '../planner/plannerModel';
import type { PaletteItem } from './paletteSearch';

import { createEmptyPlannerState } from '../planner/plannerModel';
import { collectPlannerRecords, recordDay } from './paletteRecords';
import {
  movePaletteIndex, normalizePaletteText, PALETTE_GROUP_LIMIT, searchPalette, splitByRanges,
} from './paletteSearch';

function item(group: PaletteItem['group'], title: string, text?: string): PaletteItem {
  return {
    key: `${group}:${title}`, group, title, text,
  };
}

function titles(items: PaletteItem[], query: string, limit?: number) {
  return searchPalette(items, query, limit).map(({ group, results }) => (
    [group, results.map((result) => result.item.title)]
  ));
}

const ITEMS: PaletteItem[] = [
  item('command', 'Календарь'),
  item('command', 'Здоровье'),
  item('command', 'Новая запись'),
  item('chat', 'Алёна Ёлкина'),
  item('chat', 'Семья'),
  item('note', 'Сервер X99', 'Стоит в шкафу.\nЗаменить вентилятор до зимы'),
  item('note', 'Подсервер', 'Запасной'),
  item('note', 'Ёлка и подарки', 'Купить календарь на стену'),
  item('record', 'Созвон по серверу', 'обсудить вентилятор'),
  item('record', 'Проверить работы'),
];

describe('палитра: сравнение строк', () => {
  it('регистр и «ё/е» не различаются, длина строки сохраняется', () => {
    expect(normalizePaletteText('Ёлка И ЕЛЬ')).toBe('елка и ель');
    for (const value of ['Ёлка', 'İstanbul', 'Straße', 'Заметка 😀 дня']) {
      expect(normalizePaletteText(value)).toHaveLength(value.length);
    }
  });

  const rows: [query: string, found: string[]][] = [
    ['елк', ['Алёна Ёлкина', 'Ёлка и подарки']],
    ['ЁЛК', ['Алёна Ёлкина', 'Ёлка и подарки']],
    ['алена', ['Алёна Ёлкина']],
    ['СЕМЬЯ', ['Семья']],
    ['x99', ['Сервер X99']],
    ['нет такого', []],
  ];
  it.each(rows)('«%s»', (query, found) => {
    const all = searchPalette(ITEMS, query).flatMap(({ results }) => results.map((r) => r.item.title));
    expect(all).toEqual(found);
  });
});

describe('палитра: порядок и группы', () => {
  it('пустой запрос — только команды, все и в исходном порядке', () => {
    expect(titles(ITEMS, '   ')).toEqual([['command', ['Календарь', 'Здоровье', 'Новая запись']]]);
    const many = Array.from({ length: PALETTE_GROUP_LIMIT + 4 }, (_, i) => item('command', `Команда ${i}`));
    expect(searchPalette(many, '')[0].results).toHaveLength(many.length);
  });

  it('группы идут в постоянном порядке: команды, чаты, заметки, записи', () => {
    expect(titles(ITEMS, 'календарь')).toEqual([
      ['command', ['Календарь']],
      ['note', ['Ёлка и подарки']],
    ]);
    expect(searchPalette(ITEMS, 'сервер').map(({ group }) => group)).toEqual(['note', 'record']);
  });

  it('начало названия выше начала слова, начало слова выше середины слова, текст — ниже названия', () => {
    const notes = [
      item('note', 'Подсервер'),
      item('note', 'Заметка', 'про сервер'),
      item('note', 'Мой сервер'),
      item('note', 'Сервер X99'),
    ];
    expect(titles(notes, 'сервер')).toEqual([
      ['note', ['Сервер X99', 'Мой сервер', 'Подсервер', 'Заметка']],
    ]);
  });

  it('при равном совпадении сохраняется порядок источника', () => {
    const notes = [item('note', 'План Б'), item('note', 'План А'), item('note', 'План В')];
    expect(titles(notes, 'план')).toEqual([['note', ['План Б', 'План А', 'План В']]]);
  });

  it('каждое слово запроса должно найтись — в названии либо в тексте', () => {
    expect(titles(ITEMS, 'сервер вентилятор')).toEqual([
      ['note', ['Сервер X99']],
      ['record', ['Созвон по серверу']],
    ]);
    expect(titles(ITEMS, 'сервер подарки')).toEqual([]);
  });

  it('группа обрезается до предела, лучшие совпадения остаются', () => {
    const notes = [
      ...Array.from({ length: 10 }, (_, i) => item('note', `Подзаметка ${i}`)),
      item('note', 'Заметка главная'),
    ];
    const [section] = searchPalette(notes, 'заметка');
    expect(section.results).toHaveLength(PALETTE_GROUP_LIMIT);
    expect(section.results[0].item.title).toBe('Заметка главная');
    expect(searchPalette(notes, 'заметка', 2)[0].results).toHaveLength(2);
    // С запросом предел действует и на команды
    const commands = Array.from({ length: 10 }, (_, i) => item('command', `Команда ${i}`));
    expect(searchPalette(commands, 'команда')[0].results).toHaveLength(PALETTE_GROUP_LIMIT);
  });
});

describe('палитра: подсветка', () => {
  it('участки совпадения — по исходной строке, соседние сливаются', () => {
    const [section] = searchPalette([item('chat', 'Алёна Ёлкина')], 'але елк');
    expect(section.results[0].ranges).toEqual([[0, 3], [6, 9]]);
    expect(splitByRanges('Алёна Ёлкина', section.results[0].ranges)).toEqual([
      { text: 'Алё', isMatch: true },
      { text: 'на ', isMatch: false },
      { text: 'Ёлк', isMatch: true },
      { text: 'ина', isMatch: false },
    ]);
    const [merged] = searchPalette([item('note', 'Сервер')], 'сер серв');
    expect(merged.results[0].ranges).toEqual([[0, 4]]);
  });

  it('в названии подсвечивается вхождение с начала слова, если оно есть', () => {
    const [section] = searchPalette([item('note', 'Подсервер и сервер')], 'сервер');
    expect(section.results[0].ranges).toEqual([[12, 18]]);
  });

  it('совпадение в тексте даёт отрывок строки с подсветкой, совпадение в названии — нет', () => {
    const [section] = searchPalette(ITEMS.filter(({ group }) => group === 'note'), 'вентилятор');
    const { snippet, ranges } = section.results[0];
    expect(ranges).toEqual([]);
    expect(snippet?.text).toBe('Заменить вентилятор до зимы');
    expect(splitByRanges(snippet!.text, snippet!.ranges).find((part) => part.isMatch)?.text).toBe('вентилятор');
    expect(searchPalette(ITEMS, 'семья')[0].results[0].snippet).toBeUndefined();
  });

  it('длинная строка текста обрезается вокруг совпадения', () => {
    const text = `${'начало '.repeat(20)}ключ ${'конец '.repeat(40)}`;
    const [section] = searchPalette([item('note', 'Заметка', text)], 'ключ');
    const snippet = section.results[0].snippet!;
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(true);
    expect(snippet.text.length).toBeLessThan(100);
    const [from, to] = snippet.ranges[0];
    expect(snippet.text.slice(from, to)).toBe('ключ');
  });
});

describe('палитра: стрелки', () => {
  it('список замкнут в кольцо', () => {
    expect(movePaletteIndex(0, 1, 3)).toBe(1);
    expect(movePaletteIndex(2, 1, 3)).toBe(0);
    expect(movePaletteIndex(0, -1, 3)).toBe(2);
    expect(movePaletteIndex(5, 1, 0)).toBe(0);
  });
});

describe('палитра: записи «Плана»', () => {
  // 8 октября 2026 — четверг
  const TODAY = '2026-10-08';

  function task(patch: Partial<PlannerTask>): PlannerTask {
    return {
      id: 't1', name: 'Задача', description: '', steps: [], status: 'queue', project: '', rank: 0, ...patch,
    };
  }

  function event(patch: Partial<PlannerEvent>): PlannerEvent {
    return {
      id: 'e1', name: 'Событие', start: '10:00', end: '11:00', ...patch,
    };
  }

  function state(patch: Partial<PlannerState>): PlannerState {
    return { ...createEmptyPlannerState(), ...patch };
  }

  it('день разовой записи — её дата, ряда — ближайший экземпляр от сегодня', () => {
    expect(recordDay(task({ day: '2026-10-01' }), TODAY)).toBe('2026-10-01');
    expect(recordDay(task({}), TODAY)).toBeUndefined();
    const weekly = event({
      repeat: {
        kind: 'weekly', interval: 1, weekdays: [1], startDay: '2026-09-01',
      },
    });
    expect(recordDay(weekly, TODAY)).toBe('2026-10-12');
    // Исключённый день пропускается
    expect(recordDay({ ...weekly, occurrences: [{ day: '2026-10-12', excluded: true }] }, TODAY)).toBe('2026-10-19');
    // Ряд закончился — открывается его начало
    expect(recordDay(event({
      repeat: {
        kind: 'daily', interval: 1, startDay: '2026-09-01', endDay: '2026-09-05',
      },
    }), TODAY)).toBe('2026-09-01');
  });

  it('собираются события, задачи и тренировки с названием — еда и показатели не входят', () => {
    const records = collectPlannerRecords(state({
      tasks: [task({
        id: 't1', name: 'Проверить работы', description: 'до пятницы', steps: [{ text: '9 класс', isDone: false }],
      })],
      events: [event({ id: 'e1', name: 'Созвон', description: 'по серверу', day: '2026-10-09' })],
      health: [
        {
          id: 'h1', day: '2026-10-07', kind: 'workout', value: 60, name: 'Зал', exercises: [{ name: 'Присед' }],
        },
        {
          id: 'h2', day: '2026-10-08', kind: 'weight', value: 72,
        },
        {
          id: 'h3', day: '2026-10-08', kind: 'workout', value: 30,
        },
      ],
    }), TODAY);
    expect(records.map(({ key, day }) => [key, day])).toEqual([
      ['event:e1', '2026-10-09'],
      ['workout:h1', '2026-10-07'],
      ['task:t1', undefined],
    ]);
    expect(titles(records, '9 класс')).toEqual([['record', ['Проверить работы']]]);
    expect(titles(records, 'присед')).toEqual([['record', ['Зал']]]);
    expect(titles(records, 'серверу')).toEqual([['record', ['Созвон']]]);
  });
});
