import { describe, expect, it } from 'vitest';

import { getWeekdayOrder, getWeekPosition } from './weekStart';

describe('weekStart', () => {
  it('неделя с понедельника: понедельник первый, воскресенье последнее', () => {
    expect(getWeekPosition(1, 1)).toBe(0);
    expect(getWeekPosition(0, 1)).toBe(6);
    expect(getWeekdayOrder(1)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('неделя с воскресенья и с субботы', () => {
    expect(getWeekPosition(0, 0)).toBe(0);
    expect(getWeekPosition(1, 0)).toBe(1);
    expect(getWeekdayOrder(0)).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(getWeekPosition(6, 6)).toBe(0);
    expect(getWeekdayOrder(6)).toEqual([5, 6, 0, 1, 2, 3, 4]);
  });
});
