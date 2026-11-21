import { describe, expect, it } from 'vitest';

import { getIsAutoloadAllowed } from './autoloadMode';

describe('getIsAutoloadAllowed', () => {
  it('«всегда» и «никогда» не смотрят на связь', () => {
    expect(getIsAutoloadAllowed('always', 'cellular')).toBe(true);
    expect(getIsAutoloadAllowed('never', 'wifi')).toBe(false);
  });

  it('«только Wi-Fi»: мобильная связь — нет, Wi-Fi, провод и неизвестный тип — да', () => {
    expect(getIsAutoloadAllowed('wifi', 'cellular')).toBe(false);
    expect(getIsAutoloadAllowed('wifi', 'wifi')).toBe(true);
    expect(getIsAutoloadAllowed('wifi', 'ethernet')).toBe(true);
    expect(getIsAutoloadAllowed('wifi', undefined)).toBe(true);
  });
});
