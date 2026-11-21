import { describe, expect, it } from 'vitest';

import type { HealthParsedEntry } from './healthTypes';

import { buildSleepVerdict, isSleepSpan } from './healthUnderstood';

const TODAY = '2026-11-15';

function night(time: string, endTime: string, minutes: number, endDay = TODAY): HealthParsedEntry {
  return {
    kind: 'sleep',
    atMs: 1000,
    endMs: 1000 + minutes * 60000,
    tzMin: 180,
    value: minutes,
    value2: 0,
    unit: 'min',
    source: 'text',
    day: '2026-11-14',
    time,
    endDay,
    endTime,
  };
}

describe('buildSleepVerdict', () => {
  it('сравнивает ночь с целью длительности и отбоя', () => {
    expect(buildSleepVerdict(night('00:00', '07:00', 420), TODAY, 450, 23 * 60 + 40)).toEqual({
      night: 'today', totalDelta: -30, bedDelta: 20,
    });
  });

  it('малое отклонение — ровно по цели, отбой без разницы не упоминается', () => {
    expect(buildSleepVerdict(night('23:40', '07:10', 450), TODAY, 452, 23 * 60 + 38)).toEqual({
      night: 'today', totalDelta: 0, bedDelta: undefined,
    });
  });

  it('без целей — только день ночи', () => {
    expect(buildSleepVerdict(night('23:00', '06:00', 420, '2026-11-14'), TODAY)).toEqual({
      night: 'yesterday', totalDelta: undefined, bedDelta: undefined,
    });
  });

  it('отбой раньше цели через полночь', () => {
    expect(buildSleepVerdict(night('22:30', '06:30', 480), TODAY, undefined, 30).bedDelta).toBe(-120);
  });
});

describe('isSleepSpan', () => {
  it('ночь со временем — раскладка, длительность — нет', () => {
    expect(isSleepSpan(night('00:00', '07:00', 420))).toBe(true);
    expect(isSleepSpan({ ...night('00:00', '', 420), endMs: 0, endTime: undefined })).toBe(false);
  });
});
