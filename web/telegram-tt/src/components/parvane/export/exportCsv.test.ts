import { describe, expect, it } from 'vitest';

import { buildContactsCsv, buildHealthCsv, toCsv } from './exportCsv';

const BOM = '﻿';

describe('exportCsv', () => {
  it('поля с запятой, кавычкой и переводом строки — в кавычках, строки через CRLF', () => {
    expect(toCsv([['a', 'b,c'], ['say "hi"', 'two\nlines'], [1, undefined]]))
      .toBe(`${BOM}a,"b,c"\r\n"say ""hi""","two\nlines"\r\n1,\r\n`);
  });

  it('здоровье: части записи — своими столбцами по имени', () => {
    const csv = buildHealthCsv([
      {
        kind: 'food', day: '2026-03-01', atMs: Date.UTC(2026, 2, 1, 12), value: 520, unit: 'kcal', name: 'суп',
        parts: { protein: 20, fat: 9 },
      },
      { kind: 'water', day: '2026-03-01', atMs: Date.UTC(2026, 2, 1, 13), value: 250, unit: 'ml' },
    ]);
    const [head, food, water] = csv.slice(1).split('\r\n');
    expect(head).toBe('day,time,kind,value,value2,unit,name,tag,note,end,fat,protein');
    expect(food).toBe('2026-03-01,2026-03-01T12:00:00.000Z,food,520,,kcal,суп,,,,9,20');
    expect(water).toBe('2026-03-01,2026-03-01T13:00:00.000Z,water,250,,ml,,,,,,');
  });

  it('контакты: имя, адрес, добавлен ли вручную', () => {
    expect(buildContactsCsv([{ name: 'Сова', address: 'owl@example.test', isExplicit: true }]))
      .toBe(`${BOM}name,address,added\r\nСова,owl@example.test,true\r\n`);
  });
});
