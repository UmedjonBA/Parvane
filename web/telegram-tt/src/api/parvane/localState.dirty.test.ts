import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import { createLocalState } from './localState';

const SELF = 'state-dirty@local';

const values = new Map<string, string>();
const testLocalStorage = {
  getItem: (key: string) => values.get(key),
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => values.clear(),
};

function makeLocalState() {
  return createLocalState({
    getStore: () => ({ self: SELF } as never),
    isAuthorized: () => true,
    selfId: () => SELF,
    sendUpdate: () => undefined,
    buildLocalContent: () => ({}),
    sendMessage: () => Promise.resolve(undefined),
  });
}

// Правка личного состояния, которую журнал v2 ещё не принял, помнится между
// перезагрузками: подключение журнала сначала досылает её, а не затирает
// снимком с сервера (блокировка за секунду до reload терялась — T135)
describe('unsynced personal state survives a reload', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', testLocalStorage);
    values.clear();
  });

  it('a user change marks its kind dirty until the journal confirms it', () => {
    const state = makeLocalState();
    expect(state.loadDirtyKinds()).toEqual([]);
    state.saveBlocked(['bob@local']);
    expect(state.loadDirtyKinds()).toEqual(['blocked']);

    // «Перезагрузка»: новый экземпляр видит несохранённый вид
    const reloaded = makeLocalState();
    expect(reloaded.loadDirtyKinds()).toEqual(['blocked']);
    expect(reloaded.loadBlocked()).toEqual(['bob@local']);

    reloaded.clearDirtyKinds(reloaded.getDirtyRevision());
    expect(reloaded.loadDirtyKinds()).toEqual([]);
  });

  it('a change made while the journal write is in flight stays dirty', () => {
    const state = makeLocalState();
    state.saveBlocked(['bob@local']);
    const revision = state.getDirtyRevision();
    state.saveBlocked(['bob@local', 'carol@local']);
    state.clearDirtyKinds(revision);
    expect(state.loadDirtyKinds()).toEqual(['blocked']);
  });

  it('applying the journal snapshot does not mark anything dirty', () => {
    const state = makeLocalState();
    state.applyFromJournal(() => state.saveBlocked(['bob@local']));
    expect(state.loadDirtyKinds()).toEqual([]);
  });
});
