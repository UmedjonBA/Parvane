import { beforeEach, describe, expect, it } from 'vitest';

import type { WireStoredMessage } from './wire';

import { createLocalState } from './localState';
import { SecureE2eStorage } from './secureStorage';

const SELF = 'history-cache@local';

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

describe('history cache and own outgoing journal', () => {
  beforeEach(async () => {
    await SecureE2eStorage.clear(SELF);
  });

  // Сервер не шлёт эхо отправителю: своё исходящее сразу уходит строкой модели (spec 035 T114) через слушатель
  // отправленного; своего кэша строк у localState больше нет
  it('own outgoing message goes to the sent listener and the outgoing journal, not to a history cache', async () => {
    const state = makeLocalState();
    const sent: WireStoredMessage = {
      id: '01a0da74-38ad-7f01-9d2b-e03eb50f042f',
      from: SELF,
      to: 'bob@local',
      ts: 1_790_371_444,
      content: { kind: 'file', text: 'file-caption', file_id: 'f-1', file_name: 'payload.bin' } as never,
    };
    const heard: string[] = [];
    state.setOwnSentListener((entry) => heard.push(entry.id));
    state.appendOwnJournal(sent);
    expect(heard).toEqual([sent.id]);
    expect((await state.readOwnJournal()).map(({ id }) => id)).toEqual([sent.id]);
    expect(await state.loadHistoryRecords()).toEqual([]);
    state.setOwnSentListener(undefined);
  });

  // perf A6: журнал исходящих — записью на сообщение, прежняя запись `journal`
  // целиком и localStorage `hist` переносятся один раз и стираются
  it('migrates the whole-journal record into per-message rows once', async () => {
    const storage = await SecureE2eStorage.open(SELF);
    const legacy: WireStoredMessage[] = [
      { id: 'uuid-b', from: SELF, to: 'bob@local', ts: 20, content: { kind: 'text', text: 'b' } },
      { id: 'uuid-a', from: SELF, to: 'bob@local', ts: 10, content: { kind: 'text', text: 'a' } },
    ];
    await storage.saveRecord('journal', legacy);
    const state = makeLocalState();
    state.appendOwnJournal({
      id: 'uuid-c', from: SELF, to: 'bob@local', ts: 30, content: { kind: 'text', text: 'c' },
    });
    expect((await state.readOwnJournal()).map(({ id }) => id)).toEqual(['uuid-a', 'uuid-b', 'uuid-c']);
    expect(await storage.loadRecord('journal')).toBeUndefined();
    const rows = await storage.loadRecordsByPrefix<WireStoredMessage>('j:');
    expect(rows.map(({ id }) => id).sort()).toEqual(['uuid-a', 'uuid-b', 'uuid-c']);

    // Правка и удаление трогают только свою запись; новая сессия читает строки
    state.updateOwnJournalEntry({ ...legacy[0], content: { kind: 'text', text: 'b2' }, edited: true });
    await state.removeOwnJournalEntries(['uuid-a']);
    const fresh = makeLocalState();
    const reloaded = await fresh.readOwnJournal();
    expect(reloaded.map(({ id }) => id)).toEqual(['uuid-b', 'uuid-c']);
    expect(reloaded[0].content).toEqual({ kind: 'text', text: 'b2' });
  });

  // Кэш строк прежних сборок (`m:`, маркеры `rm:`) читается для разового переноса в модель и стирается
  it('reads the legacy history cache once and drops it after the move to the engine model', async () => {
    const storage = await SecureE2eStorage.open(SELF);
    const row: WireStoredMessage = {
      id: 'uuid-old', from: 'bob@local', to: SELF, ts: 5, content: { kind: 'text', text: 'старое' },
    };
    await storage.saveRecord('m:uuid-old', row);
    await storage.saveRecord('rm:bob@local', {
      address: 'bob@local',
      mark: { chat: { user: { address: 'bob@local' } }, up_to_ts_ms: '5000', up_to_id: 'uuid-old' },
    });
    const state = makeLocalState();
    expect((await state.loadHistoryRecords()).map(({ id }) => id)).toEqual(['uuid-old']);
    expect(Object.keys(await state.loadReadMarks())).toEqual(['bob@local']);
    await state.dropLegacyHistory(['uuid-old'], ['bob@local']);
    expect(await state.loadHistoryRecords()).toEqual([]);
    expect(await state.loadReadMarks()).toEqual({});
  });

  it('forgetting an own message removes it from the outgoing journal', async () => {
    const state = makeLocalState();
    state.appendOwnJournal({
      id: 'uuid-forget', from: SELF, to: 'bob@local', ts: 1, content: { kind: 'text', text: 'x' },
    });
    await state.removeOwnJournalEntries(['uuid-forget']);
    expect(await state.readOwnJournal()).toEqual([]);
  });
});
