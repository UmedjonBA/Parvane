import { describe, expect, it } from 'vitest';

import type { LangFn } from '../../../util/localization';

import {
  formatDate, formatDay, formatDayHeading, formatDayLabel, formatDayLong, formatDayShort, formatDue, formatDurationFull,
  formatMonth, formatMonthShort, formatNumber, formatPeriod, formatRecordCaption, formatRelativeDay, formatRepeat,
  formatRepeatShort, formatWeekday, formatWeekdayShort, formatWeekNumber, formatWeekRange, getLoadLevel,
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

  it('номер недели — по ISO 8601', () => {
    expect(formatWeekNumber('2026-11-15')).toBe(46);
    expect(formatWeekNumber('2026-11-16')).toBe(47);
    expect(formatWeekNumber('2026-01-01')).toBe(1);
    expect(formatWeekNumber('2027-01-01')).toBe(53);
    expect(formatWeekNumber('2024-12-30')).toBe(1);
  });

  it('ступени загрузки дня — четыре', () => {
    expect(getLoadLevel(0, 480)).toBe(0);
    expect(getLoadLevel(60, 0)).toBe(0);
    expect(getLoadLevel(120, 480)).toBe(1);
    expect(getLoadLevel(240, 480)).toBe(2);
    expect(getLoadLevel(400, 480)).toBe(3);
    expect(getLoadLevel(900, 480)).toBe(3);
  });

  // Ключ с параметрами — «ключ:значения», чтобы подписи было видно в проверке
  const ruKeys = Object.assign((key: string, vars?: Record<string, unknown>) => (
    vars ? `${key}:${Object.values(vars).join(',')}` : key
  ), { code: 'ru' }) as unknown as LangFn;

  it('подписи дней и недель по доскам (`DeskPlan`, `RdPlan`, `RpPlan`)', () => {
    const lang = langOf('ru');
    expect(formatWeekRange(lang, '2026-11-11')).toBe('9–15 ноября');
    expect(formatWeekRange(lang, '2026-12-02')).toBe('30 нояб – 6 дек');
    expect(formatWeekdayShort(lang, '2026-11-16')).toBe('пн');
    expect(formatDayHeading(ruKeys, '2026-11-15', '2026-11-15')).toBe('PlannerToday, вс 15 ноября');
    expect(formatDayHeading(ruKeys, '2026-11-17', '2026-11-15')).toBe('Вт 17 ноября');
    expect(formatDue(ruKeys, '2026-11-20', '2026-11-15')).toBe('PlannerDueValue:пт');
    expect(formatDue(ruKeys, '2026-12-20', '2026-11-15')).toBe('PlannerDueValue:20 декабря');
  });

  it('подпись строки записи, повтор по одному дню, длительность словами', () => {
    const weekly = { kind: 'weekly' as const, interval: 1, weekdays: [3] };
    expect(formatRecordCaption(ruKeys, {
      kind: 'event', minutes: 90, repeat: weekly,
    })).toBe('PlannerKindEvent · PlannerHoursValue:1 PlannerMinutesValue:30 · PlannerEveryWednesday');
    expect(formatRecordCaption(ruKeys, { kind: 'task', minutes: 60, group: 'Дом' }))
      .toBe('PlannerKindTask · PlannerHoursValue:1 · PlannerCaptionGroup:Дом');
    expect(formatRepeatShort(ruKeys, weekly)).toBe('PlannerEveryWednesday');
    // День записи — тот же день недели: «Каждую неделю» без перечня
    expect(formatRepeat(ruKeys, weekly, '2026-11-18')).toBe('PlannerRepeatWeeklyPlain');
    expect(formatDurationFull(ruKeys, 15)).toBe('PlannerMinutesFull:15');
    expect(formatDurationFull(ruKeys, 90)).toBe('PlannerHoursFull:1 PlannerMinutesFull:30');
  });
});
