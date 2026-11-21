import { describe, expect, it } from 'vitest';

import { chartSlots, shiftDay } from './healthPeriods';

describe('healthPeriods', () => {
  const metric = {
    series: [
      { day: '2026-10-20', weekday: 1, value: 74, value2: 0 },
      { day: '2026-11-09', weekday: 0, value: 73, value2: 0 },
      { day: '2026-11-15', weekday: 6, value: 72, value2: 0 },
    ],
    year: [{ month: '2026-09' }, { month: '2026-10', value: 74 }, { month: '2026-11', value: 72.5 }],
  };

  it('shifts days across months', () => {
    expect(shiftDay('2026-11-15', -6)).toBe('2026-11-09');
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('lays out every day of the period and months of the year', () => {
    const week = chartSlots({ metric }, 'week', '2026-11-15');
    expect(week).toHaveLength(7);
    expect(week[0]).toMatchObject({ key: '2026-11-09', weekday: 0, value: 73 });
    expect(week[3].value).toBeUndefined();
    expect(week[6]).toMatchObject({ key: '2026-11-15', weekday: 6, value: 72 });
    expect(chartSlots({ metric }, 'month', '2026-11-15')[3]).toMatchObject({ key: '2026-10-20', value: 74 });
    expect(chartSlots({ metric }, 'year', '2026-11-15').map((slot) => slot.value)).toEqual([undefined, 74, 72.5]);
  });

  it('gives sleep minutes by day or by month', () => {
    const sleep = {
      month: [{ day: '2026-11-14', weekday: 5 }, { day: '2026-11-15', weekday: 6, minutes: 480 }],
      year: [{ month: '2026-11', minutes: 450 }],
    };
    expect(chartSlots({ sleep }, 'month', '2026-11-15').slice(-2).map((slot) => slot.value)).toEqual([undefined, 480]);
    expect(chartSlots({ sleep }, 'year', '2026-11-15')).toEqual([{ key: '2026-11', value: 450, weekday: 0 }]);
  });
});
