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

  it('экземпляры ряда сводятся по дню; удаление заменяет прежние правки', () => {
    expect(coalesceChanges([
      { task: { id: 't1', occurrences: [{ day: '2026-10-12', done: false }] } },
      { task: { id: 't1', occurrences: [{ day: '2026-10-12', done: true }, { day: '2026-10-13', done: true }] } },
      { list: { id: 'l1', name: 'Дом' } },
      { list: { id: 'l1', color: 3 } },
      { event: { id: 'e2', name: 'Созвон' } },
      { event: { id: 'e2', deleted: true } },
    ])).toEqual([
      { task: { id: 't1', occurrences: [{ day: '2026-10-12', done: true }, { day: '2026-10-13', done: true }] } },
      { list: { id: 'l1', name: 'Дом', color: 3 } },
      { event: { id: 'e2', deleted: true } },
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

  it('история ввода текстом: поздняя запись строки заменяет раннюю, забытая и добавленная снова — остаётся', () => {
    expect(coalesceChanges([
      { quickLine: { id: 'q1', text: 'созвон завтра 16:00', count: 1, touched: 1, hidden: false } },
      { task: { id: 't1', name: 'созвон' } },
      { quickLine: { id: 'q1', text: 'Созвон завтра 16:00', count: 2, touched: 2, hidden: false } },
      { quickLine: { id: 'q2', text: 'вес 72,4', count: 1, touched: 3, hidden: false } },
      { quickLine: { id: 'q2', deleted: true } },
      { quickLine: { id: 'q3', deleted: true } },
      { quickLine: { id: 'q3', text: 'зал 19:00', count: 1, touched: 4, hidden: false } },
    ])).toEqual([
      { quickLine: { id: 'q1', text: 'Созвон завтра 16:00', count: 2, touched: 2, hidden: false } },
      { task: { id: 't1', name: 'созвон' } },
      { quickLine: { id: 'q2', deleted: true } },
      { quickLine: { id: 'q3', text: 'зал 19:00', count: 1, touched: 4, hidden: false } },
    ]);
  });

  it('перенос данных и незнакомое остаются как есть', () => {
    const changes = [{ migration: { count: 1 } }, { migration: { count: 2 } }, {}];
    expect(coalesceChanges(changes)).toEqual(changes);
  });
});
