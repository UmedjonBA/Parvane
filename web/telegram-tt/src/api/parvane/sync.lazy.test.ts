import {
  describe, expect, it, vi,
} from 'vitest';

import type { ApiUpdate } from '../types';
import type { WireStoredMessage } from './wire';

import { ParvaneStore } from './store';
import { createSyncController } from './sync';

// Языковой пакет тянет за собой весь провайдер — тексты в тесте не нужны
vi.mock('../../util/localization', () => ({ getLangStringByKey: () => undefined }));

// spec 036 T015: чат читается из модели в стор асинхронно (`ensureChatLoaded`). Изменения модели, пришедшие между
// чтением строк и их показом, не должны теряться: снятое («удалить у себя» из журнала истории) не возвращается,
// изменённое — показывается последней версией. Имена и адреса — выдуманные

const SELF = 'alice@local';
const PEER = 'bob@local';
const ID_GONE = '018f0000-0000-7000-8000-0000000000a1';
const ID_EDITED = '018f0000-0000-7000-8000-0000000000a2';
const ID_LAST = '018f0000-0000-7000-8000-0000000000a3';

function row(id: string, ts: number, text: string): WireStoredMessage {
  return {
    id, from: PEER, to: SELF, ts, content: { kind: 'text', text }, origin: 'v2', inModel: true, order: ts * 1000,
  };
}

function makeSync() {
  const store = new ParvaneStore();
  store.self = SELF;
  const updates: ApiUpdate[] = [];
  let release: (() => void) | undefined;
  const chatRows = [row(ID_GONE, 1_700_000_001, 'удалю у себя'), row(ID_EDITED, 1_700_000_002, 'до правки')];
  const rows = {
    loadStored: () => Promise.resolve({ rows: [], known: new Set<string>(), isReady: true }),
    // Чтение чата «зависает», пока тест не отпустит: за это время модель успевает снять и изменить строки
    loadChat: (address: string) => (address !== PEER ? Promise.resolve({ rows: [], known: new Set<string>() })
      : new Promise<{ rows: WireStoredMessage[]; known: Set<string> }>((resolve) => {
        const snapshot = chatRows.map((r) => ({ ...r }));
        release = () => resolve({ rows: snapshot, known: new Set(snapshot.map((r) => r.id)) });
      })),
    lastRows: () => Promise.resolve([row(ID_LAST, 1_700_000_003, 'последнее')]),
    persistLocal: (stored: WireStoredMessage) => Promise.resolve(stored),
    forget: () => Promise.resolve(),
  };
  const sync = createSyncController({
    getConnection: () => undefined,
    getStore: () => store,
    getToken: () => 'jwt',
    groups: { register: () => undefined },
    localState: {
      isBlocked: () => false,
      updateOwnJournalEntry: () => undefined,
      scheduleTtlDeletion: () => undefined,
      readOwnJournal: () => Promise.resolve([]),
    } as never,
    rows,
    media: { rememberKeys: () => undefined },
    polls: {} as never,
    taskOffers: { handle: () => false } as never,
    refreshPollMessage: () => undefined,
    rememberSavedGif: () => undefined,
    sendUpdate: (update) => { updates.push(update); },
    log: () => undefined,
  });
  return {
    store, sync, updates, release: () => release!(),
  };
}

describe('T015: изменения модели во время чтения чата из модели', () => {
  it('снятое за время чтения не возвращается, изменённое — последней версией', async () => {
    const t = makeSync();
    await t.sync.ensureSynced();
    const chatId = t.store.getIdForAddress(PEER, 'user');
    expect(t.store.getMessages(chatId).map((m) => m.content.text?.text)).toEqual(['последнее']);
    const loading = t.sync.ensureChatLoaded(chatId);
    // Пока чат читается: «удалить у себя» из журнала — надгробие, правка старой строки — новая версия
    await t.sync.showRow({ ...row(ID_GONE, 1_700_000_001, ''), content: { kind: 'unsupported' }, deleted: true });
    await t.sync.showRow(row(ID_EDITED, 1_700_000_002, 'после правки'));
    t.release();
    await loading;
    const texts = t.store.getMessages(chatId).map((m) => m.content.text?.text);
    expect(texts).toEqual(['после правки', 'последнее']);
    expect(t.store.getMessageByUuid(ID_GONE)).toBeUndefined();
  });
});
