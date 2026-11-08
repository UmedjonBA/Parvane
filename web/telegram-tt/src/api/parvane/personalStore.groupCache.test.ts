import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import * as personalStore from './personalStore';

vi.mock('./secureStorage', () => ({
  onStorageCleared: () => undefined,
  SecureE2eStorage: { open: () => Promise.reject(new Error('нет хранилища в тесте')) },
}));

// spec 035 T108/T118 (OPT-016, SC-009): на старте с G группами web не пишет кэш сведений групп вовсе — своего кэша
// нет, сведения групп читаются из журналов групп в хранилище модели движка сразу после её открытия. Базис T009 —
// 4 записи на 4 группы (`local-workdirs/spec035/baseline/counters.md`), после T108 — одна, после T118 — ноль.
describe('OPT-016: кэш групп на старте', () => {
  it('своего кэша сведений групп у web нет', () => {
    const exported = Object.keys(personalStore);
    expect(exported).not.toContain('saveGroupCache');
    expect(exported).not.toContain('loadGroupCache');
    expect(exported).not.toContain('flushGroupCache');
  });

  it('группы для UI — из журналов модели, счётчик записей кэша — ноль', () => {
    const controller = readFileSync(path.join(__dirname, 'v2/controller.ts'), 'utf8');
    const start = controller.indexOf('function cachedGroups(): WireGroupInfo[] {');
    expect(start).toBeGreaterThan(0);
    const body = controller.slice(start, controller.indexOf('\n  }\n', start));
    expect(body).toContain('client.groupList().flatMap((hex) => {');
    expect(controller).not.toMatch(/saveGroupCache\(/);
    expect(controller).toContain('groupCacheWrites: 0,');
  });
});
