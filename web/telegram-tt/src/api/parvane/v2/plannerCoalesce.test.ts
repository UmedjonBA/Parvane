/* eslint-disable no-null/no-null -- JSON движка: null = «не задано» */
import { describe, expect, it } from 'vitest';

import { coalesceChanges } from './plannerCoalesce';

describe('планировщик: склейка правок одной операции', () => {
  it('поздняя правка поля заменяет раннюю; порядок объектов сохраняется', () => {
    expect(coalesceChanges([
      { task: { id: 't1', name: 'а', minutes: 30 } },
      { event: { id: 'e1', name: 'б' } },
      { task: { id: 't1', name: 'в' } },
      { settings: { budget: 600 } },
      { settings: { budget: 480 } },
    ])).toEqual([
      { task: { id: 't1', name: 'в', minutes: 30 } },
      { event: { id: 'e1', name: 'б' } },
      { settings: { budget: 480 } },
    ]);
  });

  it('день питания: вода после еды не теряется, записи сводятся по id', () => {
    expect(coalesceChanges([
      { nutritionDay: { day: '2026-10-12', entries: [{ id: 'f1', name: 'обед', kcal: 500 }], waterMl: null } },
      { nutritionDay: { day: '2026-10-12', entries: [], waterMl: 250 } },
      {
        nutritionDay: {
          day: '2026-10-12', entries: [{ id: 'f1', name: 'обед', kcal: 520 }, { id: 'f2', deleted: true }],
        },
      },
      { nutritionDay: { day: '2026-10-12', entries: [], waterMl: 750 } },
      { nutritionDay: { day: '2026-10-13', entries: [], waterMl: 100 } },
    ])).toEqual([
      {
        nutritionDay: {
          day: '2026-10-12',
          entries: [{ id: 'f1', name: 'обед', kcal: 520 }, { id: 'f2', deleted: true }],
          waterMl: 750,
        },
      },
      { nutritionDay: { day: '2026-10-13', entries: [], waterMl: 100 } },
    ]);
  });

  it('экземпляры ряда сводятся по дню; удаление заменяет прежние правки', () => {
    expect(coalesceChanges([
      { task: { id: 't1', occurrences: [{ day: '2026-10-12', done: false }] } },
      { task: { id: 't1', occurrences: [{ day: '2026-10-12', done: true }, { day: '2026-10-13', done: true }] } },
      { health: { id: 'h1', kind: 'weight', value: 72.4 } },
      { health: { id: 'h1', kind: 'weight', value: 72.1 } },
      { health: { id: 'h2', kind: 'pulse', value: 64 } },
      { health: { id: 'h2', deleted: true } },
    ])).toEqual([
      { task: { id: 't1', occurrences: [{ day: '2026-10-12', done: true }, { day: '2026-10-13', done: true }] } },
      { health: { id: 'h1', kind: 'weight', value: 72.1 } },
      { health: { id: 'h2', deleted: true } },
    ]);
  });

  it('словарь правок: несколько правок одного слова в пакете — одна, поздние поля побеждают', () => {
    expect(coalesceChanges([
      { learned: { id: 'пара', kind: '', kindCount: 0, minutes: 105, minutesCount: 1, touched: 1 } },
      { task: { id: 't1', name: 'а' } },
      { learned: { id: 'пара', minutes: 105, minutesCount: 2, touched: 2 } },
      { learned: { id: 'созвон', kind: 'event', kindCount: 1, minutes: null, minutesCount: 0, touched: 3 } },
      { learned: { id: 'пара', kind: 'event', kindCount: 1, touched: 4 } },
      { learned: { id: 'зал', kind: 'event', kindCount: 1, minutes: null, minutesCount: 0, touched: 5 } },
      { learned: { id: 'зал', deleted: true } },
      // Слово удалено и выучено заново в том же пакете: остаётся новая запись целиком
      { learned: { id: 'урок', deleted: true } },
      { learned: { id: 'урок', kind: '', kindCount: 0, minutes: 45, minutesCount: 1, touched: 6 } },
    ])).toEqual([
      { learned: { id: 'пара', kind: 'event', kindCount: 1, minutes: 105, minutesCount: 2, touched: 4 } },
      { task: { id: 't1', name: 'а' } },
      { learned: { id: 'созвон', kind: 'event', kindCount: 1, minutes: null, minutesCount: 0, touched: 3 } },
      { learned: { id: 'зал', deleted: true } },
      { learned: { id: 'урок', kind: '', kindCount: 0, minutes: 45, minutesCount: 1, touched: 6 } },
    ]);
  });

  it('перенос данных и незнакомое остаются как есть', () => {
    const changes = [{ migration: { count: 1 } }, { migration: { count: 2 } }, {}];
    expect(coalesceChanges(changes)).toEqual(changes);
  });
});
