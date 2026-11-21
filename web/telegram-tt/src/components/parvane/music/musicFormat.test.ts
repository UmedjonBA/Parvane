import { describe, expect, it } from 'vitest';

import {
  coverTone, estimateOfflineLeft, formatTrackTime, splitBytes, splitListTime,
} from './musicFormat';

describe('Оформление значений «Музыки»', () => {
  it('длительность трека и списка', () => {
    expect(formatTrackTime(0)).toBe('0:00');
    expect(formatTrackTime(222)).toBe('3:42');
    expect(formatTrackTime(3725)).toBe('1:02:05');
    expect(splitListTime(6720)).toEqual({ hours: 1, minutes: 52 });
    expect(splitBytes(5 * 1024 * 1024 * 1024)).toEqual({ value: 5, isGigabytes: true });
    expect(splitBytes(300 * 1024 * 1024)).toEqual({ value: 300, isGigabytes: false });
  });

  it('тон заглушки обложки постоянен для одного id', () => {
    expect(coverTone('al-1')).toBe(coverTone('al-1'));
    expect(coverTone('al-1')).toMatch(/^var\(--pv-[a-z]+\)$/);
  });

  it('оценка оставшейся загрузки на устройство', () => {
    // Два трека по 6 МБ за 60 с: ещё 10 треков — 60 МБ, 5 минут
    expect(estimateOfflineLeft(12_000_000, 60_000, 2, 10)).toEqual({ bytes: 60_000_000, minutes: 5 });
    expect(estimateOfflineLeft(0, 0, 0, 10)).toBeUndefined();
    expect(estimateOfflineLeft(1000, 1000, 1, 1)?.minutes).toBe(1);
  });
});
