import { describe, expect, it } from 'vitest';

import { formatMemberSince } from './parvaneMemberSince';

const NOW = new Date(2026, 10, 21, 12).getTime();

describe('formatMemberSince', () => {
  it('недавний — день и месяц', () => {
    expect(formatMemberSince(new Date(2026, 10, 16).getTime(), NOW, 'ru')).toBe('16 ноября');
  });

  it('давний — месяц в родительном падеже без числа', () => {
    expect(formatMemberSince(new Date(2026, 2, 5).getTime(), NOW, 'ru')).toBe('марта');
    expect(formatMemberSince(new Date(2026, 4, 30).getTime(), NOW, 'ru')).toBe('мая');
  });

  it('прошлый год — с годом', () => {
    expect(formatMemberSince(new Date(2025, 8, 1).getTime(), NOW, 'ru')).toBe('сентября 2025');
  });

  it('английский — название месяца', () => {
    expect(formatMemberSince(new Date(2026, 2, 5).getTime(), NOW, 'en')).toBe('March');
  });
});
