import { describe, expect, it } from 'vitest';

import { describeUpgradeProgress } from './parvaneUpgrade';

describe('parvaneUpgrade', () => {
  it('новая сборка в кэше — готово', () => {
    expect(describeUpgradeProgress('a1', 'b2', undefined, false)).toEqual({ kind: 'ready' });
    expect(describeUpgradeProgress('a1', undefined, undefined, true)).toEqual({ kind: 'ready' });
  });

  it('идёт набор — проценты вниз', () => {
    expect(describeUpgradeProgress('a1', undefined, { done: 64, total: 100 }, false))
      .toEqual({ kind: 'downloading', percent: 64 });
    expect(describeUpgradeProgress('a1', undefined, { done: 2, total: 3 }, false))
      .toEqual({ kind: 'downloading', percent: 66 });
  });

  it('в кэше целиком текущая — новой версии на сервере нет', () => {
    expect(describeUpgradeProgress('a1', 'a1', { done: 10, total: 10 }, false)).toEqual({ kind: 'missing' });
  });

  it('ответа ещё нет — проверяем', () => {
    expect(describeUpgradeProgress('a1', undefined, undefined, false)).toEqual({ kind: 'checking' });
  });
});
