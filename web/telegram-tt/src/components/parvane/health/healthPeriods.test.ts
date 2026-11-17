import { describe, expect, it } from 'vitest';

import { metricPoints, shiftDay, sleepPoints } from './healthPeriods';

describe('healthPeriods', () => {
  const metric = {
    series: [
      { day: '2026-10-20', value: 74, value2: 0 },
      { day: '2026-11-09', value: 73, value2: 0 },
      { day: '2026-11-15', value: 72, value2: 0 },
    ],
    year: [{ month: '2026-09' }, { month: '2026-10', value: 74 }, { month: '2026-11', value: 72.5 }],
  };

  it('shifts days across months', () => {
    expect(shiftDay('2026-11-15', -6)).toBe('2026-11-09');
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('picks the slice of the engine series for the period', () => {
    expect(metricPoints(metric, 'week', '2026-11-15')).toEqual([73, 72]);
    expect(metricPoints(metric, 'month', '2026-11-15')).toEqual([74, 73, 72]);
    expect(metricPoints(metric, 'year', '2026-11-15')).toEqual([74, 72.5]);
  });

  it('gives sleep minutes by day or by month and nothing for the week', () => {
    const sleep = {
      month: [{ day: '2026-11-14' }, { day: '2026-11-15', minutes: 480 }],
      year: [{ month: '2026-11', minutes: 450 }],
    };
    expect(sleepPoints(sleep, 'month')).toEqual([undefined, 480]);
    expect(sleepPoints(sleep, 'year')).toEqual([450]);
    expect(sleepPoints(sleep, 'week')).toEqual([]);
  });
});
