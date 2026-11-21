import { describe, expect, it } from 'vitest';

import { countDaysLeft } from './authFormat';

describe('countDaysLeft', () => {
  const day = 24 * 60 * 60 * 1000;

  it('counts a partial day as a whole one', () => {
    const now = Date.UTC(2026, 10, 16, 10, 0);
    expect(countDaysLeft(now + 6 * day, now)).toBe(6);
    expect(countDaysLeft(now + 5 * day + 1, now)).toBe(6);
  });

  it('never goes below zero', () => {
    expect(countDaysLeft(1000, 2000)).toBe(0);
  });
});
