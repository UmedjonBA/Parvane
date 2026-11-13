// spec 035 T118: виды журнала личного состояния (папки, блок-лист, контакты, …) после первого переноса журнала —
// проекция показа модели движка в памяти, своей копии на диске у web нет. На диске вид лежит, только пока несёт
// правку пользователя, ещё не принятую журналом (переживает перезагрузку до подключения); запуск без сети
// показывает сведённое моделью в прошлый раз (`viewStateJson`). Данные выдуманные.
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { StateModelView } from './v2/engine';

import { createStateJournal } from './v2/stateJournal';
import { createLocalState } from './localState';
import { flushPersonal, forgetPersonal } from './personalStore';
import { SecureE2eStorage, secureStorageInternals } from './secureStorage';

const SELF = 'backed-local@local';

const values = new Map<string, string>();
const testLocalStorage = {
  get length() { return values.size; },
  key: (index: number) => Array.from(values.keys())[index],
  getItem: (key: string) => values.get(key) ?? null, // eslint-disable-line no-null/no-null
  setItem: (key: string, value: string) => {
    values.set(key, String(value));
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
  clear: () => values.clear(),
};

const STORE = {
  self: SELF,
  getIdForAddress: (address: string) => address,
  isGroupAddress: () => false,
};

function makeState(view?: () => StateModelView | undefined) {
  const ref: { journal?: ReturnType<typeof createStateJournal> } = {};
  const state = createLocalState({
    getStore: () => STORE as never,
    isAuthorized: () => true,
    selfId: () => SELF,
    sendUpdate: () => undefined,
    buildLocalContent: () => ({}),
    sendMessage: () => Promise.resolve(undefined),
    projectOffline: view ? () => Promise.resolve(ref.journal!.showOffline(view())) : undefined,
  });
  ref.journal = createStateJournal({
    localState: state,
    getStore: () => STORE as never,
    sendUpdate: () => undefined,
    log: () => undefined,
  });
  return state;
}

function viewOf(folders: { id: number; title: string }[]): StateModelView {
  return {
    objects: folders.map((f) => ({
      kind: 'OBJECT_KIND_FOLDER', key: String(f.id), value: f, marks: [],
    })),
    write_blocked: false,
  };
}

async function restart() {
  await flushPersonal(SELF);
  forgetPersonal(SELF);
  (secureStorageInternals as unknown as { forgetAll?: () => void }).forgetAll?.();
}

async function diskRecord(name: string) {
  const storage = await SecureE2eStorage.open(SELF);
  return storage.loadRecord<{ part: string; v: string }>(name);
}

describe('T118: виды журнала — показ модели, не своя копия', () => {
  beforeEach(async () => {
    vi.stubGlobal('localStorage', testLocalStorage);
    values.clear();
    await SecureE2eStorage.clear(SELF);
  });

  it('после проекции подключённого журнала записей видов на диске нет, значения — в памяти', async () => {
    const state = makeState();
    await state.hydrate();
    state.saveFolders([{ id: 2, title: { text: 'Папка-тест' } }]);
    state.saveBlocked(['blocked-test@x']);
    await flushPersonal(SELF);
    expect((await diskRecord('ls:folders'))?.v).toContain('Папка-тест');

    // Журнал принял правки и спроецировал сведённое
    state.clearDirtyKinds(state.getDirtyRevision());
    state.applyFromJournal(() => {
      state.saveFolders([{ id: 2, title: { text: 'Папка-тест' } }]);
      state.saveBlocked(['blocked-test@x']);
    });
    state.markProjected(true);
    await flushPersonal(SELF);
    expect(await diskRecord('ls:folders')).toBeUndefined();
    expect(await diskRecord('ls:blocked')).toBeUndefined();
    expect(state.loadFolders()).toEqual([{ id: 2, title: { text: 'Папка-тест' } }]);
    expect(state.isBlocked('blocked-test@x')).toBe(true);
  });

  it('запуск без сети — виды из показа модели; правка до подключения переживает перезапуск', async () => {
    const first = makeState();
    await first.hydrate();
    first.saveFolders([{ id: 2, title: { text: 'Старая' } }]);
    first.clearDirtyKinds(first.getDirtyRevision());
    first.markProjected(true);
    await restart();

    let model = viewOf([{ id: 2, title: 'Из модели' }]);
    const second = makeState(() => model);
    await second.hydrate();
    expect((second.loadFolders()[0] as { title?: { text?: string } }).title?.text).toBe('Из модели');

    // Правка без сети: на диске до принятия журналом, после перезапуска главнее показа модели
    second.saveFolders([{ id: 2, title: { text: 'Правка-офлайн' } }]);
    await restart();
    model = viewOf([{ id: 2, title: 'Из модели' }]);
    const third = makeState(() => model);
    await third.hydrate();
    expect((third.loadFolders()[0] as { title?: { text?: string } }).title?.text).toBe('Правка-офлайн');
    expect(third.loadDirtyKinds()).toContain('folders');
    expect(third.loadPartialKinds()).not.toContain('folders');
  });

  it('правка до первой проекции (показа модели нет) дописывается без удаления пропавшего', async () => {
    const first = makeState();
    await first.hydrate();
    first.saveFolders([{ id: 2, title: { text: 'Была' } }]);
    first.clearDirtyKinds(first.getDirtyRevision());
    first.markProjected(true);
    await restart();

    const second = makeState(() => undefined);
    await second.hydrate();
    expect(second.loadFolders()).toEqual([]);
    expect(second.isPersonalComplete()).toBe(false);
    second.saveFolders([{ id: 3, title: { text: 'Новая' } }]);
    expect(second.loadPartialKinds()).toContain('folders');
  });
});
