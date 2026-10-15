import { describe, expect, it } from 'vitest';

import type { QuickContext } from './plannerQuick';

import { parseQuickInput } from './plannerQuick';

const CTX: QuickContext = {
  today: '2026-10-08', nowMinutes: 12 * 60, dayStart: 9 * 60, dayEnd: 21 * 60,
};

describe('ввод текстом: напоминание', () => {
  it.each([
    ['созвон завтра 16:00 напомнить за 15 мин', 'созвон', 15, 'ru'],
    ['отчёт пт напомни мне за час', 'отчёт', 60, 'ru'],
    ['встреча 18:00 напоминание за 2 часа', 'встреча', 120, 'ru'],
    ['врач 12.10 10:30 напомнить за день', 'врач', 1440, 'ru'],
    ['полить цветы завтра напомнить', 'полить цветы', 0, 'ru'],
    ['call tomorrow 4pm remind me 10 min before', 'call', 10, 'en'],
    ['dentist friday 9am reminder 1 day before', 'dentist', 1440, 'en'],
  ] as const)('«%s»', (line, name, minutes, lang) => {
    const draft = parseQuickInput(line, { ...CTX, lang });
    expect(draft.name).toBe(name);
    expect(draft.remind).toBe(minutes);
    expect(draft.spans.some(({ field }) => field === 'remind')).toBe(true);
  });

  it('без слова «напомнить» напоминания нет; снятый чип возвращает слова в название', () => {
    expect(parseQuickInput('созвон завтра 16:00 за 15 мин', CTX).remind).toBeUndefined();
    const skipped = parseQuickInput('созвон завтра 16:00 напомнить за 15 мин', { ...CTX, skip: ['remind'] });
    expect(skipped.remind).toBeUndefined();
    expect(skipped.name).toContain('напомнить');
  });
});
