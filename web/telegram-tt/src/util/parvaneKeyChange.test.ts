import {
  describe, expect, it, vi,
} from 'vitest';

const values = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => values.get(key) ?? null, // eslint-disable-line no-null/no-null
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
});

describe('Смена ключа собеседника', () => {
  it('чат помнится до сверки и переживает перезагрузку', async () => {
    const first = await import('./parvaneKeyChange');
    first.markKeyChanged('42');
    first.markKeyChanged('42');
    expect(first.getKeyChangedChats()).toEqual(['42']);
    vi.resetModules();
    const reloaded = await import('./parvaneKeyChange');
    expect(reloaded.getKeyChangedChats()).toEqual(['42']);
    reloaded.clearKeyChanged('42');
    expect(reloaded.getKeyChangedChats()).toEqual([]);
    expect(values.get('parvane:key-changed')).toBe('[]');
  });
});
