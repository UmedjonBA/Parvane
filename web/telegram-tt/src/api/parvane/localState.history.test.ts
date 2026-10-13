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

  // Сервер не шлёт эхо отправителю, а курсор дельта-синка двигают живые
  // входящие — своё исходящее обязано попасть в кэш истории уже при отправке,
  // иначе после reload пропадало (документ с подписью в e2e_web_media_ttl)
  it('own outgoing message lands in the history cache without a sync round-trip', async () => {
    const state = makeLocalState();
    const sent: WireStoredMessage = {
      id: '01a0da74-38ad-7f01-9d2b-e03eb50f042f',
      from: SELF,
      to: 'bob@local',
      ts: 1_790_371_444,
      content: { kind: 'file', text: 'file-caption', file_id: 'f-1', file_name: 'payload.bin' } as never,
    };
    state.appendOwnJournal(sent);
    await state.flushHistoryNow();

    const records = await state.loadHistoryRecords();
    expect(records.map(({ id }) => id)).toEqual([sent.id]);
    expect(records[0].content).toEqual(sent.content);
    expect((await state.readOwnJournal()).map(({ id }) => id)).toEqual([sent.id]);
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

  it('writes a burst of history rows as one batch', async () => {
    const state = makeLocalState();
    for (let i = 0; i < 300; i++) {
      state.saveHistoryRecord({
        id: `uuid-${String(i).padStart(4, '0')}`, from: 'bob@local', to: SELF, ts: i,
        content: { kind: 'text', text: 'x' },
      });
    }
    state.deleteHistoryRecord('uuid-0000');
    await state.flushHistoryNow();
    const records = await state.loadHistoryRecords();
    expect(records.length).toBe(299);
    expect(records.some(({ id }) => id === 'uuid-0000')).toBe(false);
  });

  it('forgetting an own message removes it from the cache too', async () => {
    const state = makeLocalState();
    state.appendOwnJournal({
      id: 'uuid-forget', from: SELF, to: 'bob@local', ts: 1, content: { kind: 'text', text: 'x' },
    });
    await state.flushHistoryNow();
    state.deleteHistoryRecord('uuid-forget');
    await state.removeOwnJournalEntries(['uuid-forget']);
    await state.flushHistoryNow();

    expect(await state.loadHistoryRecords()).toEqual([]);
    expect(await state.readOwnJournal()).toEqual([]);
  });
});
