import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import type { WireGroupInfo } from './wire';

import {
  flushGroupCache, loadGroupCache, personalStoreInternals, saveGroupCache,
} from './personalStore';

vi.mock('./secureStorage', () => ({
  onStorageCleared: () => undefined,
  SecureE2eStorage: { open: () => Promise.reject(new Error('нет хранилища в тесте')) },
}));

// spec 035 T108 (OPT-016, SC-009): на старте с G группами кэш сведений групп записывается не G раз (каждый раз
// весь список, O(G²) байт), а одной записью; повторный старт без изменений не пишет ничего. Базис T009 — 4 записи
// на 4 группы (`local-workdirs/spec035/baseline/counters.md`).
const USER = 'alice@example.test';
const GROUPS = 100;

function info(i: number, title = `Группа ${i}`): WireGroupInfo {
  return { group_id: `v2g:${i.toString(16).padStart(32, '0')}`, title } as unknown as WireGroupInfo;
}

describe('OPT-016: кэш групп на старте', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('100 групп при запуске — не больше одной записи кэша', () => {
    vi.useFakeTimers();
    const before = personalStoreInternals.groupCacheWrites();
    for (let i = 0; i < GROUPS; i++) saveGroupCache(USER, info(i), true);
    // Чтение до записи видит правки
    expect(loadGroupCache(USER)).toHaveLength(GROUPS);
    vi.runAllTimers();
    expect(personalStoreInternals.groupCacheWrites() - before).toBeLessThanOrEqual(1);
    expect(loadGroupCache(USER)).toHaveLength(GROUPS);
  });

  it('тот же список при следующем запуске — ни одной записи; правка одной группы — одна', () => {
    vi.useFakeTimers();
    const before = personalStoreInternals.groupCacheWrites();
    for (let i = 0; i < GROUPS; i++) saveGroupCache(USER, info(i), true);
    flushGroupCache(USER);
    expect(personalStoreInternals.groupCacheWrites()).toBe(before);
    saveGroupCache(USER, info(7, 'Новое название'), true);
    saveGroupCache(USER, info(8), false);
    vi.runAllTimers();
    expect(personalStoreInternals.groupCacheWrites() - before).toBe(1);
    const list = loadGroupCache(USER);
    expect(list).toHaveLength(GROUPS - 1);
    expect(list.find((g) => g.group_id === info(7).group_id)?.title).toBe('Новое название');
  });
});
