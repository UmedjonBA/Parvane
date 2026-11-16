import { describe, expect, it } from 'vitest';

import { coverTone, formatTrackTime, splitListTime } from './musicFormat';

describe('Оформление значений «Музыки»', () => {
  it('длительность трека и списка', () => {
    expect(formatTrackTime(0)).toBe('0:00');
    expect(formatTrackTime(222)).toBe('3:42');
    expect(formatTrackTime(3725)).toBe('1:02:05');
    expect(splitListTime(6720)).toEqual({ hours: 1, minutes: 52 });
  });

  it('тон заглушки обложки постоянен для одного id', () => {
    expect(coverTone('al-1')).toBe(coverTone('al-1'));
    expect(coverTone('al-1')).toMatch(/^var\(--pv-[a-z]+\)$/);
  });
});
