import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import { createLocalState } from './localState';

// WEB-10: после полного выхода в localStorage не остаётся записей аккаунта — ни перечисленных видов, ни
// групп, собеседников, приглашений; записи другого аккаунта и общие настройки остаются
const SELF = 'alice@local';

const values = new Map<string, string>();
const testLocalStorage = {
  get length() { return values.size; },
  key: (index: number) => Array.from(values.keys())[index],
  getItem: (key: string) => values.get(key),
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => values.clear(),
};

describe('выход стирает записи аккаунта', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', testLocalStorage);
    values.clear();
  });

  it('все записи адреса, и только его', () => {
    const own = [
      `parvane:hist:${SELF}`, `parvane:v2groups:${SELF}`, `parvane:invites:${SELF}`, `parvane:v2peers:${SELF}`,
      `parvane:readuuids:${SELF}`, `parvane:strangers:${SELF}`, `parvane:kind:${SELF}:notify`,
    ];
    const kept = [
      'parvane:hist:bob@local', 'parvane:v2groups:malice@local', 'parvane:color-scheme', 'parvane:planner-view',
      'tt-global-state',
    ];
    [...own, ...kept].forEach((key) => values.set(key, '1'));
    const state = createLocalState({
      getStore: () => ({ self: SELF } as never),
      isAuthorized: () => true,
      selfId: () => SELF,
      sendUpdate: () => undefined,
      buildLocalContent: () => ({}),
      sendMessage: () => Promise.resolve(undefined),
    });
    state.clearUserData(SELF);
    expect(Array.from(values.keys()).sort()).toEqual([...kept].sort());
  });
});
