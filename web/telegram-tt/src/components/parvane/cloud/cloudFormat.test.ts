import { describe, expect, it } from 'vitest';

import { formatCloudDayLong, formatCloudDayShort } from './cloudFormat';

const NOW = new Date(2026, 10, 20, 12).getTime();

describe('даты «Файлов»', () => {
  it('короткая дата — три буквы месяца, без года в текущем году', () => {
    expect(formatCloudDayShort('ru', new Date(2026, 10, 13).getTime(), NOW)).toBe('13 ноя');
    expect(formatCloudDayShort('ru', new Date(2026, 8, 14).getTime(), NOW)).toBe('14 сен');
    expect(formatCloudDayShort('ru', new Date(2025, 4, 2).getTime(), NOW)).toBe('2 мая 2025');
    expect(formatCloudDayShort('en', new Date(2026, 10, 13).getTime(), NOW)).toBe('Nov 13');
  });

  it('длинная дата — полный месяц, год только не текущий', () => {
    expect(formatCloudDayLong('ru', new Date(2026, 10, 22).getTime(), NOW)).toBe('22 ноября');
    expect(formatCloudDayLong('ru', new Date(2027, 0, 5).getTime(), NOW)).toContain('2027');
  });
});
