import { describe, expect, it } from 'vitest';

import type { HOp } from './v2/historyModel';
import type { WireStoredMessage } from './wire';

import { addressForPeer, encodeBody, newStamp, rowOpFromStored } from './v2/historyModel';
import { createMessageIndex } from './v2/messageIndex';
import { createHistoryRows } from './historyRows';
import { openRowsModel } from './rowsModel.testkit';

// Журнал истории аккаунта (spec 033, HIST-1, READ-2) и строки в модели движка (spec 035 T114): строками владеет модель
// (`rowsApply`/`rowsAll` WASM-движка над хранилищем в памяти), у web своей копии строк нет — показ и индекс строятся
// из её представлений. Имена и адреса — выдуманные

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

type Opts = {
  // Кэш строк прежних сборок (`m:`) — переносится в модель при первом обращении
  legacy?: WireStoredMessage[];
  // Строки вне модели в памяти показа (самоуничтожение собеседника)
  memory?: WireStoredMessage[];
  model?: Awaited<ReturnType<typeof openRowsModel>>;
};

async function makeRows(opts: Opts = {}) {
  const model = opts.model || await openRowsModel(SELF);
  const shown: WireStoredMessage[] = [];
  const touched: string[] = [];
  const enqueued: { op: HOp; isOwn: boolean }[] = [];
  const dropped: string[] = [];
  const logs: string[] = [];
  // eslint-disable-next-line prefer-const -- хранилище строк обращается к нему лениво
  let rows: ReturnType<typeof createHistoryRows>;
  const index = createMessageIndex({
    loadAll: async () => [...(await rows.loadStored()).rows, ...(opts.memory || [])],
  });
  (opts.memory || []).forEach((m) => index.set(m));
  rows = createHistoryRows({
    self: () => SELF,
    domain: () => DOMAIN,
    index,
    model: () => Promise.resolve(model.rows),
    show: (stored) => {
      shown.push(stored);
      return Promise.resolve();
    },
    onChatsTouched: (addresses) => touched.push(...addresses),
    loadClearedUntil: () => ({}),
    journal: () => ({ enqueue: (op, o) => enqueued.push({ op, isOwn: o.isOwn }) }),
    legacy: {
      load: () => Promise.resolve(dropped.length ? [] : opts.legacy || []),
      loadMarks: () => Promise.resolve({}),
      drop: (uuids) => {
        dropped.push(...uuids);
        return Promise.resolve();
      },
    },
    log: (message) => logs.push(message),
  });
  const state = async (id: string) => (await model.rows.all({ states: true })).states?.find((s) => s.target === id);
  return {
    rows, index, model, shown, touched, enqueued, dropped, logs, state,
    row: (id: string) => index.get(id),
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

describe('T114: строки истории — в модели движка, у web своей копии нет', () => {
  it('строка, надгробие и место в ленте читаются из модели после её перезапуска', async () => {
    const t = await makeRows();
    await t.rows.ingest(rowOp(text(ID1, PEER, SELF, 1000)), { source: 'inbox', author: PEER });
    await t.rows.ingest(rowOp(text(ID2, PEER, SELF, 1001)), { source: 'inbox', author: PEER });
    await t.rows.ingest({
      gone: { target: ID2, chat: DIRECT, stamp: newStamp(2_000_000), scope: 'GONE_SCOPE_EVERYONE', by: PEER },
    }, { source: 'inbox', author: PEER });
    const order = t.row(ID1)?.order;
    expect(order).toBeGreaterThan(0);
    // Тот же профиль заново (перезагрузка вкладки): новый хост модели над тем же хранилищем
    const again = await openRowsModel(SELF, { store: t.model.store, deviceKey: t.model.deviceKey });
    const t2 = await makeRows({ model: again });
    const { rows, known } = await t2.rows.loadStored();
    expect(rows.map((r) => [r.id, r.content.text, r.order])).toEqual([[ID1, 'привет', order]]);
    expect(rows[0].inModel).toBe(true);
    expect(known.has(ID2)).toBe(true);
    // Удалённое не воскресает и после перезапуска (запись журнала с другого устройства)
    await t2.rows.ingest(rowOp(text(ID2, PEER, SELF, 1001)), { source: 'journal' });
    expect((await t2.rows.loadStored()).rows.map((r) => r.id)).toEqual([ID1]);
    // Страница ленты и список чатов — модели
    const page = await t2.rows.page(PEER, { direction: 'older', limit: 10 });
    expect(page?.rows.map((r) => r.id)).toEqual([ID1]);
    expect(await t2.rows.chatsWithRows()).toEqual([{ address: PEER, last: ID1 }]);
  });

  it('ORDER-1: живой ответ с отстающими часами — после показанного, место хранит модель', async () => {
    const t = await makeRows();
    const nowSecs = Math.floor(Date.now() / 1000);
    await t.rows.ingest(rowOp(text(ID1, SELF, PEER, nowSecs, 'вопрос')), { source: 'own' });
    await t.rows.ingest(rowOp(text(ID2, PEER, SELF, nowSecs - 60, 'ответ')), { source: 'inbox', author: PEER });
    expect(t.row(ID2)!.order!).toBeGreaterThan(t.row(ID1)!.order!);
    const page = await t.rows.page(PEER, { direction: 'older', limit: 10 });
    expect(page?.rows.map((r) => r.content.text)).toEqual(['вопрос', 'ответ']);
  });

  it('прежний кэш строк переносится в модель один раз, место прежнее, затем стирается', async () => {
    const legacy = { ...text(ID1, PEER, SELF, 10), order: 10_500, reactors: [{ user: PEER, emoji: '🔥', ts: 11 }] };
    const t = await makeRows({ legacy: [legacy] });
    const { rows } = await t.rows.loadStored();
    expect(rows.map((r) => [r.id, r.order])).toEqual([[ID1, 10_500]]);
    expect(rows[0].reactions?.[0]).toMatchObject({ emoji: '🔥', count: 1 });
    expect(t.dropped).toEqual([ID1]);
  });

  it('квитанция ✓✓, удаление у себя, строка вне журнала и замена точкой — в модели', async () => {
    const t = await makeRows();
    await t.rows.ingest(rowOp(text(ID1, SELF, PEER, 10)), { source: 'own' });
    expect((await t.rows.receipt(PEER, ID1))?.read).toBe(true);
    const stub: WireStoredMessage = {
      id: ID2, from: PEER, to: SELF, ts: 11, content: { kind: 'unsupported', critical: true },
    };
    await t.rows.persistLocal(stub);
    expect(t.row(ID2)?.inModel).toBe(true);
    expect(t.enqueued.map((e) => Object.keys(e.op)[0])).toEqual(['row']);
    // Заглушка — строка модели, но не журнала (в точку не входит)
    expect((await t.rows.collectStates()).map((s) => s.target)).toEqual([ID1]);
    await t.rows.forget([ID2]);
    expect((await t.rows.loadStored()).rows.map((r) => r.id)).toEqual([ID1]);
    expect((await t.rows.wipe()).sort()).toEqual([ID1]);
    expect((await t.rows.loadStored()).known.size).toBe(0);
  });
});

describe('HIST-1: строка истории — сведённое состояние движка', () => {
  it('удалённое остаётся надгробием и не воскресает при повторе строки (журнал, перезапуск)', async () => {
    const t = await makeRows();
    const msg = text(ID1, PEER, SELF, 1000);
    await t.rows.ingest(rowOp(msg), { source: 'inbox', author: PEER });
    expect(t.row(ID1)?.deleted).toBeFalsy();
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(2_000_000), scope: 'GONE_SCOPE_EVERYONE' },
    }, { source: 'own' });
    const tomb = t.row(ID1)!;
    expect(tomb.deleted).toBe(true);
    expect((await t.state(ID1))?.gone).toBeDefined();
    expect(JSON.stringify(tomb)).not.toContain('привет');
    // Строка пришла снова (запись журнала с другого устройства, точка) — показа нет
    await t.rows.ingest(rowOp(msg), { source: 'journal' });
    expect(t.row(ID1)?.deleted).toBe(true);
    expect(t.shown.at(-1)?.deleted).toBe(true);
  });

  it('удаление раньше сообщения: сирота хранится, пришедшее сообщение не появляется', async () => {
    const t = await makeRows();
    await t.rows.ingest({
      gone: { target: ID2, chat: DIRECT, stamp: newStamp(5000), scope: 'GONE_SCOPE_EVERYONE', by: PEER },
    }, { source: 'inbox', author: PEER });
    expect((await t.state(ID2))?.pending_gones?.length).toBe(1);
    await t.rows.ingest(rowOp(text(ID2, PEER, SELF, 4)), { source: 'inbox', author: PEER });
    expect((await t.state(ID2))?.gone).toBeDefined();
    expect(t.shown.every((m) => m.deleted)).toBe(true);
  });

  it('правка раньше сообщения применяется, когда сообщение придёт', async () => {
    const t = await makeRows();
    const body = encodeBody({ edit_patch: { text: 'исправлено' } });
    await t.rows.ingest({ edit: { target: ID3, chat: DIRECT, stamp: newStamp(9000), body, by: PEER } }, {
      source: 'inbox', author: PEER,
    });
    expect(t.row(ID3)).toBeUndefined();
    await t.rows.ingest(rowOp(text(ID3, PEER, SELF, 8)), { source: 'inbox', author: PEER });
    const stored = t.row(ID3)!;
    expect(stored.deleted).toBeFalsy();
    expect(stored.edited).toBe(true);
    expect(stored.content.text).toBe('исправлено');
  });

  it('правку чужого сообщения не-автором отклоняет; «у всех» в личном чате — любой участник', async () => {
    const t = await makeRows();
    await t.rows.ingest(rowOp(text(ID1, SELF, PEER, 10)), { source: 'own' });
    const body = encodeBody({ content: { kind: 'text', text: 'чужая правка' } });
    await t.rows.ingest({ edit: { target: ID1, chat: DIRECT, stamp: newStamp(), body, by: PEER } }, {
      source: 'inbox', author: PEER,
    });
    expect(t.row(ID1)?.edited).toBeFalsy();
    // Та же подмена раньше МОЕГО сообщения (новое устройство: инбокс раньше журнала) — тоже не применяется
    await t.rows.ingest({ edit: { target: ID2, chat: DIRECT, stamp: newStamp(), body, by: PEER } }, {
      source: 'inbox', author: PEER,
    });
    await t.rows.ingest(rowOp(text(ID2, SELF, PEER, 11)), { source: 'journal' });
    expect(t.row(ID2)?.edited).toBeFalsy();
    expect(t.row(ID2)?.content.text).toBe('привет');
    // Собеседник удаляет МОЁ сообщение «у всех» — как в Telegram, разрешено
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE', by: PEER },
    }, { source: 'inbox', author: PEER });
    expect(t.row(ID1)?.deleted).toBe(true);
  });

  it('группа: чужое удаляет только админ; удаление участником до сообщения проверяется движком по автору', async () => {
    const t = await makeRows();
    const gone = (target: string, by: string, isAdmin?: boolean) => ({
      gone: {
        target, chat: GROUP_PEER, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE' as const, by, by_admin: isAdmin,
      },
    });
    await t.rows.ingest(rowOp(text(ID1, PEER, GROUP, 10), GROUP_PEER), { source: 'inbox', author: PEER });
    await t.rows.ingest(gone(ID1, OTHER), { source: 'inbox', author: OTHER });
    expect(t.row(ID1)?.deleted).toBeFalsy();
    await t.rows.ingest(gone(ID1, OTHER, true), { source: 'inbox', author: OTHER, isAdmin: true });
    expect(t.row(ID1)?.deleted).toBe(true);

    // Участник удалил своё сообщение раньше, чем оно пришло: применяется — автор совпал
    await t.rows.ingest(gone(ID2, PEER), { source: 'inbox', author: PEER });
    expect((await t.state(ID2))?.pending_gones?.length).toBe(1);
    await t.rows.ingest(rowOp(text(ID2, PEER, GROUP, 11), GROUP_PEER), { source: 'inbox', author: PEER });
    expect((await t.state(ID2))?.gone).toBeDefined();
    // …и не применяется, если удалял не автор (в любом порядке)
    await t.rows.ingest(gone(ID3, OTHER), { source: 'inbox', author: OTHER });
    await t.rows.ingest(rowOp(text(ID3, PEER, GROUP, 12), GROUP_PEER), { source: 'inbox', author: PEER });
    expect(t.row(ID3)?.deleted).toBeFalsy();
    expect((await t.state(ID3))?.pending_gones).toBeUndefined();
  });

  it('«только у меня» — область ME; в журнал: своё сразу, входящее отложенно, журнальное не пишется', async () => {
    const t = await makeRows();
    await t.rows.ingest(rowOp(text(ID1, PEER, SELF, 10)), { source: 'inbox', author: PEER });
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_ME' },
    }, { source: 'own' });
    expect((await t.state(ID1))?.gone?.scope).toBe('GONE_SCOPE_ME');
    await t.rows.ingest(rowOp(text(ID2, PEER, SELF, 11)), { source: 'journal' });
    expect(t.enqueued.map((e) => [Object.keys(e.op)[0], e.isOwn])).toEqual([['row', false], ['gone', true]]);
  });

  it('реакции — по участнику, своя отмечена', async () => {
    const t = await makeRows();
    await t.rows.ingest(rowOp(text(ID1, PEER, SELF, 10)), { source: 'inbox', author: PEER });
    await t.rows.ingest({ react: { target: ID1, chat: DIRECT, user: SELF, stamp: newStamp(), emoji: '👍' } }, {
      source: 'own',
    });
    await t.rows.ingest({ react: { target: ID1, chat: DIRECT, user: PEER, stamp: newStamp(), emoji: '👍' } }, {
      source: 'inbox', author: PEER,
    });
    expect(t.row(ID1)?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(t.row(ID1)?.reactors?.map((r) => r.user).sort()).toEqual([SELF, PEER].sort());
  });

  it('строка вне журнала (самоуничтожение собеседника) меняется в памяти и в журнал не попадает', async () => {
    const ttl: WireStoredMessage = {
      id: ID1, from: PEER, to: SELF, ts: 10, content: { kind: 'text', text: 'исчезнет', ttl_secs: 30 },
    };
    const t = await makeRows({ memory: [ttl] });
    await t.rows.ingest({
      gone: { target: ID1, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE' },
    }, { source: 'inbox', author: PEER });
    expect(t.row(ID1)?.deleted).toBe(true);
    expect(t.row(ID1)?.inModel).toBeFalsy();
    expect(await t.state(ID1)).toBeUndefined();
    expect(t.enqueued).toEqual([]);
  });

  it('своё из журнала исходящих (вне модели) сводится с операцией без потери реакций', async () => {
    const own: WireStoredMessage = {
      ...text(ID1, SELF, PEER, 10), reactors: [{ user: PEER, emoji: '🔥', ts: 11 }],
    };
    const t = await makeRows({ memory: [own] });
    await t.rows.ingest({ pin: { target: ID1, chat: DIRECT, stamp: newStamp(), pinned: true } }, { source: 'own' });
    const stored = t.row(ID1)!;
    expect(stored.pinned).toBe(true);
    expect(stored.inModel).toBe(true);
    expect(stored.reactions?.[0]).toMatchObject({ emoji: '🔥', count: 1 });
  });
});

describe('READ-2: маркер «прочитано до» и непрочитанное', () => {
  const meta = (id: string, tsMs: number, from = PEER) => ({
    id, chat: PEER, from, tsMs, kind: 'text',
  });

  it('маркер только растёт, пишется в журнал, счётчик — от маркера (движок), хранит модель', async () => {
    const t = await makeRows();
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
    const again = await makeRows({
      model: await openRowsModel(SELF, { store: t.model.store, deviceKey: t.model.deviceKey }),
    });
    await again.rows.ensureMarks();
    expect(again.rows.getMark(PEER)?.up_to_id).toBe(ID2);
  });

  it('маркер из журнала применяется без обратной записи; служебные виды непрочитанными не считаются', async () => {
    const t = await makeRows();
    await t.rows.applyJournalOps([{ read: { chat: DIRECT, up_to_ts_ms: '5000', up_to_id: ID1 } }]);
    expect(t.enqueued).toEqual([]);
    expect(t.touched).toEqual([PEER]);
    expect(t.rows.isUnread(meta(ID2, 4000))).toBe(false);
    expect(t.rows.isUnread({ ...meta(ID2, 6000), kind: 'chat_mode' })).toBe(false);
    expect(t.rows.isUnread(meta(ID2, 6000))).toBe(true);
  });

  it('перенос: маркеры по прежнему учёту прочитанного и своим сообщениям', async () => {
    const t = await makeRows({
      legacy: [text(ID1, PEER, SELF, 10), text(ID2, PEER, SELF, 20), text(ID3, SELF, PEER, 15)],
    });
    expect(await t.rows.legacyMarks(new Set([ID1]))).toBe(1);
    // Своё сообщение (15 с) позже прочитанного входящего (10 с) — маркер по нему
    expect(t.rows.getMark(PEER)?.up_to_id).toBe(ID3);
    expect(t.rows.isUnread(meta(ID2, 20000))).toBe(true);
  });

  it('сводка точки: последняя видимая строка и число непрочитанных по чату', async () => {
    const t = await makeRows();
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

// C7-2 (ревью 7 ноя 2026): участник общей группы личным сообщением не трогает сообщения группы — строка модели
// (чат сверяет движок) и строка вне модели (самоуничтожение: чат сверяется по самой строке)
describe('C7-2: мутация из чужого чата не действует на строку другого чата', () => {
  const MALLORY = 'mallory@local';
  const MALLORY_PEER = { user: { address: MALLORY } };
  const groupMsg = (extra: Partial<WireStoredMessage['content']> = {}): WireStoredMessage => ({
    id: ID1, from: PEER, to: GROUP, ts: 100, content: { kind: 'text', text: 'в группе', ...extra },
  });
  const ctx = { source: 'inbox' as const, author: MALLORY };

  it.each([
    ['строка модели', false],
    ['самоуничтожающаяся строка в памяти', true],
  ])('%s: удаление, реакция и закреп из личного чата отвергаются', async (_, isTtl) => {
    const t = isTtl ? await makeRows({ memory: [groupMsg({ ttl_secs: 30 })] }) : await makeRows();
    if (!isTtl) await t.rows.ingest(rowOp(groupMsg(), GROUP_PEER), { source: 'inbox', author: PEER });
    const enqueuedBefore = t.enqueued.length;
    const ops: HOp[] = [
      { gone: { target: ID1, chat: MALLORY_PEER, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE', by: MALLORY } },
      { react: { target: ID1, chat: MALLORY_PEER, user: MALLORY, stamp: newStamp(), emoji: '👍' } },
      { pin: { target: ID1, chat: MALLORY_PEER, stamp: newStamp(), pinned: true } },
    ];
    for (const op of ops) {
      const after = await t.rows.ingest(op, ctx);
      expect(after?.deleted || after?.pinned || after?.reactors?.length).toBeFalsy();
    }
    const row = t.row(ID1)!;
    expect(row.deleted).toBeFalsy();
    expect(row.pinned).toBeFalsy();
    expect(row.reactors || []).toEqual([]);
    expect(row.to).toBe(GROUP);
    expect(t.enqueued.length).toBe(enqueuedBefore);
  });

  it('удаление чужого сообщения самоуничтожающейся строки группы — по правилам группы', async () => {
    const t = await makeRows({ memory: [groupMsg({ ttl_secs: 30 })] });
    // В группе чужое удаляет только админ: операция из группы от не-админа не проходит
    expect(await t.rows.ingest({
      gone: { target: ID1, chat: GROUP_PEER, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE', by: MALLORY },
    }, ctx)).toBeUndefined();
    expect(t.row(ID1)?.deleted).toBeFalsy();
    // Автор удаляет своё
    expect(await t.rows.ingest({
      gone: { target: ID1, chat: GROUP_PEER, stamp: newStamp(), scope: 'GONE_SCOPE_EVERYONE', by: PEER },
    }, { source: 'inbox', author: PEER })).toBeDefined();
    expect(t.row(ID1)?.deleted).toBe(true);
  });
});
