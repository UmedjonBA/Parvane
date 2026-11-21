import { describe, expect, it } from 'vitest';

import { buildDeviceTitle, formatSeenAt, parseDeviceLabel } from './deviceTitle';

describe('deviceTitle', () => {
  it('names phones by platform, browsers by browser, the rest by platform', () => {
    expect(buildDeviceTitle('Chrome', 'Android')).toEqual({ kind: 'phone', name: 'Android' });
    expect(buildDeviceTitle('Firefox', 'Linux')).toEqual({ kind: 'browser', name: 'Firefox' });
    expect(buildDeviceTitle('Parvane Desktop', 'Linux')).toEqual({ kind: 'computer', name: 'Linux' });
    expect(buildDeviceTitle('Web 1a2b3c4d', '')).toEqual({ kind: 'computer', name: 'Web 1a2b3c4d' });
  });

  it('parses the sign-in label', () => {
    expect(parseDeviceLabel('Firefox, Linux')).toEqual({ kind: 'browser', name: 'Firefox' });
    expect(parseDeviceLabel('Safari, iOS')).toEqual({ kind: 'phone', name: 'iOS' });
    expect(parseDeviceLabel('  ')).toBeUndefined();
    expect(parseDeviceLabel(undefined)).toBeUndefined();
  });

  it('formats today with the template and other days as a date', () => {
    const now = new Date(2026, 10, 21, 18, 0).getTime();
    const today = new Date(2026, 10, 21, 13, 40).getTime();
    const before = new Date(2026, 10, 9, 10, 0).getTime();
    expect(formatSeenAt(today, now, 'ru', (time) => `сегодня, ${time}`)).toBe('сегодня, 13:40');
    expect(formatSeenAt(before, now, 'ru', (time) => time)).toBe('9 ноября');
  });
});
