// spec 036 T019: личное состояние web по видам целиком — настоящий localState и модель движка (WASM) на двух
// устройствах одного аккаунта, журнал «сервера» в памяти. Правка вида localState уходит объектами своего вида
// (`stateSet` с показанным `base`), показ — объекты модели прямо в localState; правка другого устройства не
// откатывается, непоказанное не удаляется, правки без связи дописываются при подключении (контакты — поверх журнала).
// Данные выдуманные.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  afterEach, beforeAll, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { ModelRequest, ModelSender } from './engine';

import {
  decodeMessage, encodeMessage, initSync, PvEngine,
} from '../../../lib/parvane-protocol/parvane_protocol';
import { createLocalState } from '../localState';
import { SecureE2eStorage } from '../secureStorage';
import { MemoryModelStore, ModelHost, openStateModel } from './engine';
import { createStateJournal } from './stateJournal';
import { K, objectsOf, valueOf } from './stateObjects';

type Rec = { seq: string; op_id: string; aead_ciphertext: string };

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

const CAROL = 'carol-test@local';
const DAVE = 'dave-test@local';
const ERIN = 'erin-test@local';
const FRANK = 'frank-test@local';

function bytesOf(text?: string) {
  return Uint8Array.from(atob(text || ''), (c) => c.charCodeAt(0));
}

const records: Rec[] = [];
const closers: (() => void)[] = [];

async function openPair() {
  records.length = 0;
  const config = {
    user: 'kinds-owner@local',
    device_id: 'd1',
    domain: 'local',
    now_ms: '1800000000000',
    vectors: true,
    device_key: btoa(String.fromCharCode(...Array(32).fill(11))),
  };
  const first = new MemoryModelStore();
  const device = async (self: string, store: MemoryModelStore) => {
    const queue: ModelRequest[] = [];
    let listener: (() => void) | undefined;
    const { host } = await ModelHost.open(config, {
      store, send: (r) => queue.push(r), onDelta: () => listener?.(),
    }, (cfg) => PvEngine.open(cfg));
    const sender = { failures: () => 0, idle: () => Promise.resolve() } as unknown as ModelSender;
    const pump = async () => {
      while (queue.length) {
        const r = queue.shift()!;
        let resp = new Uint8Array(0);
        if (r.method === 'state.ops.append') {
          const req = JSON.parse(decodeMessage('parvane.state.v2.AppendRequest', bytesOf(r.body))) as Rec;
          if (!records.some((x) => x.op_id === req.op_id)) {
            records.push({ seq: String(records.length + 1), op_id: req.op_id, aead_ciphertext: req.aead_ciphertext });
          }
          resp = encodeMessage('parvane.state.v2.AppendResponse', JSON.stringify({ seq: String(records.length) }));
        } else if (r.method === 'state.ops.sync') {
          const req = JSON.parse(decodeMessage('parvane.state.v2.SyncRequest', bytesOf(r.body))) as {
            after_seq?: string;
          };
          const after = Number(req.after_seq || 0);
          resp = encodeMessage('parvane.state.v2.SyncResponse',
            JSON.stringify({ records: records.filter((x) => Number(x.seq) > after) }));
        }
        await host.ingestResponse(r.req_id, resp, 0);
      }
    };
    const storeStub = {
      self,
      getIdForAddress: (address: string) => address,
      getAddressForId: (id: string) => id,
      isGroupAddress: () => false,
      buildApiUser: (address: string) => ({ id: address }),
      buildApiChatForUser: (address: string) => ({ id: address }),
    };
    const state = createLocalState({
      getStore: () => storeStub as never,
      isAuthorized: () => true,
      selfId: () => self,
      sendUpdate: () => undefined,
      buildLocalContent: () => ({}),
      sendMessage: () => Promise.resolve(undefined),
    });
    const journal = createStateJournal({
      localState: state,
      getStore: () => storeStub as never,
      sendUpdate: () => undefined,
      applyContacts: () => undefined,
      log: () => undefined,
    });
    const stateHost = {
      openModel: () => Promise.resolve(openStateModel({
        host,
        sender,
        subscribe: (next) => {
          listener = next;
        },
      })),
      encode: (type: string, json: string) => encodeMessage(type, json),
      decode: (type: string, bytes: Uint8Array) => decodeMessage(type, bytes),
      domain: () => 'local',
      log: () => undefined,
    };
    // Раунд синка: своё — в журнал, ответы «сервера», догон и показ
    const round = async () => {
      await journal.syncNow();
      await pump();
      await journal.syncNow();
      await pump();
    };
    const attach = async () => {
      await journal.attach(stateHost);
      await pump();
      await round();
    };
    closers.push(() => {
      journal.reset();
      host.close();
    });
    return {
      host, state, journal, pump, round, attach,
    };
  };
  const a = await device('kinds-a@local', first);
  await a.host.flush();
  // Второе устройство — тот же ключ личного состояния (копия профиля до первой записи)
  const copy = new MemoryModelStore();
  first.data.forEach((v, k) => copy.data.set(k, v));
  const b = await device('kinds-b@local', copy);
  return { a, b };
}

function folderTitle(state: ReturnType<typeof createLocalState>, id: number) {
  const folder = state.loadFolders().find((f) => f.id === id) as { title?: { text?: string } } | undefined;
  return folder?.title?.text;
}

describe('stateJournal: личное состояние по видам на двух устройствах (spec 036 T019)', () => {
  beforeAll(() => {
    initSync({ module: readFileSync(path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm')) });
  });

  beforeEach(async () => {
    vi.stubGlobal('localStorage', testLocalStorage);
    values.clear();
    await SecureE2eStorage.clear('kinds-a@local');
    await SecureE2eStorage.clear('kinds-b@local');
  });

  afterEach(() => {
    closers.splice(0).forEach((close) => close());
  });

  it('папки, архив, закреп, блок-лист: показ на другом устройстве, чужая правка не откатывается', async () => {
    const { a, b } = await openPair();
    await a.attach();
    await b.attach();
    a.state.saveFolders([{ id: 2, title: { text: 'Работа' }, includedChatIds: [CAROL] }]);
    a.state.setArchived(CAROL, true);
    a.state.setPinned(DAVE, true);
    a.state.saveBlocked([DAVE]);
    a.state.saveUnreadMarks([CAROL]);
    await a.round();
    await b.round();
    expect(folderTitle(b.state, 2)).toBe('Работа');
    expect(b.state.loadArchived()).toEqual([CAROL]);
    expect(b.state.loadPinned()).toEqual([DAVE]);
    expect(b.state.isBlocked(DAVE)).toBe(true);
    expect(b.state.loadUnreadMarks()).toEqual([CAROL]);

    // Второе переименовывает папку и создаёт новую; первое (показ устарел) снимает архив и отметку
    b.state.saveFolders([
      { id: 2, title: { text: 'Работа+' }, includedChatIds: [CAROL] },
      { id: 3, title: { text: 'Дом' } },
    ]);
    await b.round();
    a.state.setArchived(CAROL, false);
    a.state.saveUnreadMarks([]);
    // Модель первого уже знает правку второго (догон по живому уведомлению), а показ — нет: своя правка ещё не в
    // журнале, показ ждёт её. Без показанного (`base`) прежняя копия папок первого откатила бы переименование и
    // удалила бы непоказанную папку 3
    await a.host.ingestEvent('journal.state');
    await a.pump();
    expect(folderTitle(a.state, 2)).toBe('Работа');
    await a.round();
    // Переименование и папка, которых первое не показывало, остались; снятое первым дошло до второго
    expect(folderTitle(a.state, 2)).toBe('Работа+');
    expect(folderTitle(a.state, 3)).toBe('Дом');
    await b.round();
    expect(b.state.loadArchived()).toEqual([]);
    expect(b.state.loadUnreadMarks()).toEqual([]);
    expect(folderTitle(b.state, 3)).toBe('Дом');

    // Удаление показанного: первое убирает папку 3 — у второго её нет
    a.state.saveFolders(a.state.loadFolders().filter((f) => f.id !== 3));
    await a.round();
    await b.round();
    expect(folderTitle(b.state, 3)).toBeUndefined();
    expect(folderTitle(b.state, 2)).toBe('Работа+');
    // Значение объекта — proto3-JSON сообщения вида (как его отдаёт модель)
    const view = b.host.peek<{ objects: [] }>('viewStateJson', { kinds: [] });
    expect(valueOf(objectsOf(view, K.folder).find((o) => o.key === '2')).title).toBe('Работа+');
  });

  it('контакты, правленые без связи, дописываются поверх журнала без удаления чужих', async () => {
    const { a, b } = await openPair();
    await a.attach();
    await b.attach();
    // Второе без связи (журнал отключён) добавляет контакт; первое тем временем — свой
    b.journal.reset();
    b.state.saveContacts([ERIN]);
    b.state.saveContactInfo({ [ERIN]: { note: 'заметка-тест' } });
    expect(b.state.loadDirtyKinds()).toContain('contacts');
    a.state.saveContacts([FRANK]);
    await a.round();
    // Модель второго догоняет журнал до подключения (контакт первого уже в ней, показанного нет — сброшен)
    await b.host.ingestEvent('journal.state');
    await b.pump();
    // Подключение второго: несохранённое — в журнал, контакт первого не удаляется
    await b.attach();
    expect(b.state.loadDirtyKinds()).not.toContain('contacts');
    expect([...b.state.loadContacts()].sort()).toEqual([ERIN, FRANK]);
    expect(b.state.loadContactInfo()[ERIN]?.note).toBe('заметка-тест');
    await a.round();
    expect([...a.state.loadContacts()].sort()).toEqual([ERIN, FRANK]);
  });
});
