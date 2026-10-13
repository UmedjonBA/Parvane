import { describe, expect, it } from 'vitest';

import type { LangFn } from '../../../util/localization';

import {
  formatDate, formatDay, formatDayLabel, formatDayLong, formatDayShort, formatMonth, formatMonthShort, formatNumber,
  formatPeriod, formatRelativeDay, formatWeekday,
} from './plannerFormat';
import { fromDayKey } from './plannerModel';

const langOf = (code: string) => Object.assign((key: string) => key, { code }) as unknown as LangFn;

describe('подписи дат и чисел: кэш Intl даёт то же, что методы Date (C7)', () => {
  const days = ['2026-01-05', '2026-02-28', '2026-10-13', '2026-12-31'];
  const options: Intl.DateTimeFormatOptions[] = [
    { day: 'numeric', month: 'long' }, { day: 'numeric', month: 'short' }, { weekday: 'long' },
    { weekday: 'short', day: 'numeric', month: 'long' }, { month: 'long', year: 'numeric' }, { month: 'short' },
  ];

  ['ru', 'en', 'en-GB', 'de'].forEach((code) => {
    it(`язык ${code}`, () => {
      const lang = langOf(code);
      days.forEach((day) => {
        const date = fromDayKey(day);
        options.forEach((opts) => {
          expect(formatDate(code, date, opts)).toBe(date.toLocaleDateString(code, opts));
        });
        // Повторный вызов — из кэша, результат тот же
        expect(formatDay(lang, day)).toBe(date.toLocaleDateString(code, { day: 'numeric', month: 'long' }));
        expect(formatDay(lang, day)).toBe(formatDay(lang, day));
        expect(formatDayShort(lang, day)).toBe(formatDayShort(lang, day));
        expect(formatDayLong(lang, day)).toBe(formatDayLong(lang, day));
        expect(formatDayLabel(lang, day)).toBe(formatDayLabel(lang, day));
        expect(formatRelativeDay(lang, day, '2026-10-01')).toBe(formatRelativeDay(lang, day, '2026-10-01'));
        expect(formatPeriod(lang, 'week', day)).toBe(formatPeriod(lang, 'week', day));
        expect(formatPeriod(lang, 'month', day)).toBe(formatPeriod(lang, 'month', day));
      });
      const month = new Date(2026, 9, 1);
      expect(formatMonth(lang, month)).toBe(formatMonth(lang, month));
      expect(formatMonthShort(lang, month)).toBe(formatMonthShort(lang, month));
      expect(formatWeekday(lang, 0)).toBe(formatWeekday(lang, 0));
      [0, 1.5, 7.25, 1234.5678].forEach((value) => {
        expect(formatNumber(lang, value, 2)).toBe(value.toLocaleString(code, { maximumFractionDigits: 2 }));
        expect(formatNumber(lang, value)).toBe(value.toLocaleString(code, { maximumFractionDigits: 1 }));
      });
    });
  });

  it('русские подписи — как раньше', () => {
    const lang = langOf('ru');
    expect(formatDay(lang, '2026-10-13')).toBe('13 октября');
    expect(formatDayShort(lang, '2026-10-13')).toBe('13 окт');
    expect(formatMonth(lang, new Date(2026, 9, 1))).toBe('Октябрь 2026');
    expect(formatWeekday(lang, 0)).toBe('Пн');
    expect(formatNumber(lang, 1.5)).toBe('1,5');
  });
});
