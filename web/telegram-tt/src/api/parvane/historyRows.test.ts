import { describe, expect, it } from 'vitest';

import type { HOp, HReadMark } from './v2/historyModel';
import type { WireStoredMessage } from './wire';

import { addressForPeer, encodeBody, newStamp, rowOpFromStored } from './v2/historyModel';
import { createMessageIndex } from './v2/messageIndex';
import { createHistoryRows } from './historyRows';

// Журнал истории аккаунта (spec 033, HIST-1, READ-2): хранилище строк web поверх движка (WASM, `tests/init.ts`).
// Имена и адреса — выдуманные

const SELF = 'alice@local';
const PEER = 'bob@local';
const OTHER = 'carol@local';
const DOMAIN = 'local';
const GROUP = `v2g:${'ab'.repeat(16)}`;
const ID1 = '01923a4b-5c6d-7001-8000-000000000001';
const ID2 = '01923a4b-5c6d-7001-8000-000000000002';
const ID3 = '01923a4b-5c6d-7001-8000-000000000003';
const DIRECT = { user: { address: PEER } };
const GROUP_PEER = { group: { domain: DOMAIN, id: btoa(String.fromCharCode(...Array(16).fill(0xab))) } };

function makeRows(initial: WireStoredMessage[] = []) {
  const records = new Map<string, WireStoredMessage>(initial.map((m) => [m.id, m]));
  const shown: WireStoredMessage[] = [];
  const touched: string[] = [];
  const enqueued: { op: HOp; isOwn: boolean }[] = [];
  const marks = new Map<string, HReadMark>();
  const logs: string[] = [];
  const index = createMessageIndex({
    loadAll: () => Promise.resolve(Array.from(records.values())),
    loadOne: (uuid) => Promise.resolve(records.get(uuid)),
  });
  const rows = createHistoryRows({
    self: () => SELF,
    domain: () => DOMAIN,
    index,
    loadAll: () => Promise.resolve(Array.from(records.values())),
    saveRecord: (stored) => records.set(stored.id, stored),
    deleteRecord: (uuid) => records.delete(uuid),
    updateOwnJournal: () => undefined,
    flush: () => Promise.resolve(),
    show: (stored) => {
      shown.push(stored);
      return Promise.resolve();
    },
    onChatsTouched: (addresses) => touched.push(...addresses),
    loadMarks: () => Promise.resolve(Object.fromEntries(marks)),
    saveMark: (address, mark) => marks.set(address, mark),
    loadClearedUntil: () => ({}),
    journal: () => ({ enqueue: (op, opts) => enqueued.push({ op, isOwn: opts.isOwn }) }),
    log: (message) => logs.push(message),
  });
  return {
    rows, records, shown, touched, enqueued, marks, logs,
  };
}

function text(id: string, from: string, to: string, ts: number, body = 'привет'): WireStoredMessage {
  return {
    id, from, to, ts, content: { kind: 'text', text: body },
  };
}

function rowOp(stored: WireStoredMessage, chat = DIRECT) {
  return rowOpFromStored(stored, chat, stored.ts * 1000);
}

describe('HIST-1: строка истории — сведённое состояние движка', () => {
  it('удалённое остаётся надгробием и не воскресает при повторе строки (журнал, перезапуск)', async () => {
    const t = makeRows();
    const msg = text(ID1, PEER, SELF, 1000);
    await t.rows.ingest(rowOp(msg), { source: 'inbox', author: PEER });
    expect(t.records.get(ID1)?.deleted).toBeFalsy();
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(2_000_000), scope: 'GONE_SCOPE_EVERYONE' },
    }, { source: 'own' });
    const tomb = t.records.get(ID1)!;
    expect(tomb.deleted).toBe(true);
    expect(tomb.hs?.gone).toBeDefined();
    expect(JSON.stringify(tomb)).not.toContain('привет');
    // Строка пришла снова (запись журнала с другого устройства, точка) — показа нет
    await t.rows.ingest(rowOp(msg), { source: 'journal' });
    expect(t.records.get(ID1)?.deleted).toBe(true);
    expect(t.shown.at(-1)?.deleted).toBe(true);
  });

  it('удаление раньше сообщения: сирота хранится, пришедшее сообщение не появляется', async () => {
    const t = makeRows();
    await t.rows.ingest({
      gone: { target: ID2, chat: DIRECT, stamp: newStamp(5000), scope: 'GONE_SCOPE_EVERYONE', by: PEER },
    }, { source: 'inbox', author: PEER });
    expect(t.records.get(ID2)?.deleted).toBe(true);
    await t.rows.ingest(rowOp(text(ID2, PEER, SELF, 4)), { source: 'inbox', author: PEER });
    expect(t.records.get(ID2)?.deleted).toBe(true);
    expect(t.shown.every((m) => m.deleted)).toBe(true);
  });

  it('правка раньше сообщения применяется, когда сообщение придёт', async () => {
    const t = makeRows();
    const body = encodeBody({ edit_patch: { text: 'исправлено' } });
    await t.rows.ingest({ edit: { target: ID3, chat: DIRECT, stamp: newStamp(9000), body, by: PEER } }, {
      source: 'inbox', author: PEER,
    });
    expect(t.records.get(ID3)?.deleted).toBe(true);
    await t.rows.ingest(rowOp(text(ID3, PEER, SELF, 8)), { source: 'inbox', author: PEER });
    const stored = t.records.get(ID3)!;
    expect(stored.deleted).toBeFalsy();
    expect(stored.edited).toBe(true);
    expect(stored.content.text).toBe('исправлено');
  });

  it('правку чужого сообщения не-автором отклоняет; «у всех» в личном чате — любой участник', async () => {
    const t = makeRows();
    await t.rows.ingest(rowOp(text(ID1, SELF, PEER, 10)), { source: 'own' });
    const body = encodeBody({ content: { kind: 'text', text: 'чужая правка' } });
    await t.rows.ingest({ edit: { target: ID1, chat: DIRECT, stamp: newStamp(), body, by: PEER } }, {
      source: 'inbox', author: PEER,
    });
    expect(t.records.get(ID1)?.edited).toBeFalsy();
    // Та же подмена раньше МОЕГО сообщения (новое устройство: инбокс раньше журнала) — тоже не применяется
    await t.rows.ingest({ edit: { target: ID2, chat: DIRECT, stamp: newStamp(), body, by: PEER } }, {
      source: 'inbox', author: PEER,
    });
    await t.rows.ingest(rowOp(text(ID2, SELF, PEER, 11)), { source: 'journal' });
    expect(t.records.get(ID2)?.edited).toBeFalsy();
    expect(t.records.get(ID2)?.content.text).toBe('привет');
    // Собеседник удаляет МОЁ сообщение «у всех» — как в Telegram, разрешено
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE', by: PEER },
    }, { source: 'inbox', author: PEER });
    expect(t.records.get(ID1)?.deleted).toBe(true);
  });

  it('группа: чужое удаляет только админ; удаление участником до сообщения проверяется движком по автору', async () => {
    const t = makeRows();
    const gone = (target: string, by: string, isAdmin?: boolean) => ({
      gone: {
        target, chat: GROUP_PEER, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE' as const, by, by_admin: isAdmin,
      },
    });
    await t.rows.ingest(rowOp(text(ID1, PEER, GROUP, 10), GROUP_PEER), { source: 'inbox', author: PEER });
    await t.rows.ingest(gone(ID1, OTHER), { source: 'inbox', author: OTHER });
    expect(t.records.get(ID1)?.deleted).toBeFalsy();
    await t.rows.ingest(gone(ID1, OTHER, true), { source: 'inbox', author: OTHER, isAdmin: true });
    expect(t.records.get(ID1)?.deleted).toBe(true);

    // Участник удалил своё сообщение раньше, чем оно пришло: применяется — автор совпал
    await t.rows.ingest(gone(ID2, PEER), { source: 'inbox', author: PEER });
    expect(t.records.get(ID2)?.hs?.pending_gones?.length).toBe(1);
    await t.rows.ingest(rowOp(text(ID2, PEER, GROUP, 11), GROUP_PEER), { source: 'inbox', author: PEER });
    expect(t.records.get(ID2)?.deleted).toBe(true);
    // …и не применяется, если удалял не автор (в любом порядке)
    await t.rows.ingest(gone(ID3, OTHER), { source: 'inbox', author: OTHER });
    await t.rows.ingest(rowOp(text(ID3, PEER, GROUP, 12), GROUP_PEER), { source: 'inbox', author: PEER });
    expect(t.records.get(ID3)?.deleted).toBeFalsy();
    expect(t.records.get(ID3)?.hs?.pending_gones).toBeUndefined();
  });

  it('«только у меня» — область ME; в журнал: своё сразу, входящее отложенно, журнальное не пишется', async () => {
    const t = makeRows();
    await t.rows.ingest(rowOp(text(ID1, PEER, SELF, 10)), { source: 'inbox', author: PEER });
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_ME' },
    }, { source: 'own' });
    expect(t.records.get(ID1)?.hs?.gone?.scope).toBe('GONE_SCOPE_ME');
    await t.rows.ingest(rowOp(text(ID2, PEER, SELF, 11)), { source: 'journal' });
    expect(t.enqueued.map((e) => [Object.keys(e.op)[0], e.isOwn])).toEqual([['row', false], ['gone', true]]);
  });

  it('реакции — по участнику, своя отмечена', async () => {
    const t = makeRows();
    await t.rows.ingest(rowOp(text(ID1, PEER, SELF, 10)), { source: 'inbox', author: PEER });
    await t.rows.ingest({ react: { target: ID1, chat: DIRECT, user: SELF, stamp: newStamp(), emoji: '👍' } }, {
      source: 'own',
    });
    await t.rows.ingest({ react: { target: ID1, chat: DIRECT, user: PEER, stamp: newStamp(), emoji: '👍' } }, {
      source: 'inbox', author: PEER,
    });
    expect(t.records.get(ID1)?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
  });

  it('строка вне журнала (самоуничтожение) меняется напрямую и в журнал не попадает', async () => {
    const ttl: WireStoredMessage = {
      id: ID1, from: PEER, to: SELF, ts: 10, content: { kind: 'text', text: 'исчезнет', ttl_secs: 30 },
    };
    const t = makeRows([ttl]);
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE' },
    }, { source: 'inbox', author: PEER });
    expect(t.records.get(ID1)?.deleted).toBe(true);
    expect(t.records.get(ID1)?.hs).toBeUndefined();
    expect(t.enqueued).toEqual([]);
  });

  it('старая запись кэша (без hs) сводится с операцией без потери реакций', async () => {
    const legacy: WireStoredMessage = {
      ...text(ID1, PEER, SELF, 10), reactors: [{ user: PEER, emoji: '🔥', ts: 11 }],
    };
    const t = makeRows([legacy]);
    await t.rows.ingest({ pin: { target: ID1, chat: DIRECT, stamp: newStamp(), pinned: true } }, { source: 'own' });
    const stored = t.records.get(ID1)!;
    expect(stored.pinned).toBe(true);
    expect(stored.reactions?.[0]).toMatchObject({ emoji: '🔥', count: 1 });
    expect(stored.hs?.row?.id).toBe(ID1);
  });
});

describe('READ-2: маркер «прочитано до» и непрочитанное', () => {
  const meta = (id: string, tsMs: number, from = PEER) => ({
    id, chat: PEER, from, tsMs, kind: 'text',
  });

  it('маркер только растёт, пишется в журнал, счётчик — от маркера (движок)', async () => {
    const t = makeRows();
    await t.rows.ensureMarks();
    expect(t.rows.isUnread(meta(ID2, 2000))).toBe(true);
    expect(t.rows.isUnread(meta(ID2, 2000, SELF))).toBe(false);
    expect(await t.rows.advanceMark(PEER, 2000, ID2)).toBe(true);
    expect(t.rows.isUnread(meta(ID1, 1000))).toBe(false);
    expect(t.rows.isUnread(meta(ID2, 2000))).toBe(false);
    expect(t.rows.isUnread(meta(ID3, 3000))).toBe(true);
    // Назад не двигается
    expect(await t.rows.advanceMark(PEER, 1000, ID1)).toBe(false);
    expect(Number(t.rows.getMark(PEER)?.up_to_ts_ms)).toBe(2000);
    expect(t.enqueued.map((e) => Boolean(e.op.read))).toEqual([true]);
    expect(t.touched).toEqual([PEER]);
    expect(t.marks.get(PEER)?.up_to_id).toBe(ID2);
  });

  it('маркер из журнала применяется без обратной записи; служебные виды непрочитанными не считаются', async () => {
    const t = makeRows();
    await t.rows.applyJournalOps([{ read: { chat: DIRECT, up_to_ts_ms: '5000', up_to_id: ID1 } }]);
    expect(t.enqueued).toEqual([]);
    expect(t.rows.isUnread(meta(ID2, 4000))).toBe(false);
    expect(t.rows.isUnread({ ...meta(ID2, 6000), kind: 'chat_mode' })).toBe(false);
    expect(t.rows.isUnread(meta(ID2, 6000))).toBe(true);
  });

  it('перенос: маркеры по прежнему учёту прочитанного и своим сообщениям', async () => {
    const t = makeRows([
      text(ID1, PEER, SELF, 10),
      text(ID2, PEER, SELF, 20),
      text(ID3, SELF, PEER, 15),
    ]);
    expect(await t.rows.legacyMarks(new Set([ID1]))).toBe(1);
    // Своё сообщение (15 с) позже прочитанного входящего (10 с) — маркер по нему
    expect(t.rows.getMark(PEER)?.up_to_id).toBe(ID3);
    expect(t.rows.isUnread(meta(ID2, 20000))).toBe(true);
  });

  it('сводка точки: последняя видимая строка и число непрочитанных по чату', async () => {
    const t = makeRows();
    await t.rows.ingest(rowOp(text(ID1, PEER, SELF, 10)), { source: 'inbox', author: PEER });
    await t.rows.ingest(rowOp(text(ID2, PEER, SELF, 20)), { source: 'inbox', author: PEER });
    await t.rows.ingest({ gone: { target: ID2, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_ME' } }, {
      source: 'own',
    });
    const states = await t.rows.collectStates();
    const [chat] = t.rows.summarizeChats(states);
    expect(addressForPeer(chat.chat)).toBe(PEER);
    expect(chat.last?.target).toBe(ID1);
    expect(chat.unread).toBe(1);
    expect(chat.rows).toBe(2);
  });
});
