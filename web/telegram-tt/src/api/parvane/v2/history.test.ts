import { describe, expect, it } from 'vitest';

import type { WireStoredMessage } from '../wire';
import type { HistoryHost, HistorySyncState } from './history';

import { PvClient } from '../../../lib/parvane-protocol/parvane_protocol';
import { createHistoryRows } from '../historyRows';
import { createHistoryJournal } from './history';
import { newStamp, rowOpFromStored } from './historyModel';
import { createMessageIndex } from './messageIndex';
import { V2Error } from './transport';

// Журнал истории аккаунта (spec 033, HIST-1, HIST-2, READ-2): клиентская сторона против фальшивого сервера
// messenger (правила `history.*` из `contracts/engine-api.md`). Шифрует и разбирает настоящая сессия движка
// (WASM), два «устройства» — копии одного состояния движка (общий ключ личного состояния). Данные — выдуманные

const SELF = 'alice@local';
const PEER = 'bob@local';
const DIRECT = { user: { address: PEER } };
const ID1 = '01923a4b-5c6d-7001-8000-000000000001';
const ID2 = '01923a4b-5c6d-7001-8000-000000000002';
const ID3 = '01923a4b-5c6d-7001-8000-000000000003';
const JAN_2026_MS = Date.UTC(2026, 0, 10);
const OCT_2026_MS = Date.UTC(2026, 9, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

// ── минимальный protobuf (только поля history.v1) ─────────────────────────────────────────────────────
type Field = { no: number; wire: number; value: bigint | Uint8Array };

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let at = pos;
  for (;;) {
    const byte = buf[at++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, at];
    shift += 7n;
  }
}

function decodeFields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, next] = readVarint(buf, pos);
    pos = next;
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [value, after] = readVarint(buf, pos);
      pos = after;
      out.push({ no, wire, value });
    } else {
      const [len, after] = readVarint(buf, pos);
      out.push({ no, wire, value: buf.subarray(after, after + Number(len)) });
      pos = after + Number(len);
    }
  }
  return out;
}

const num = (fields: Field[], no: number) => Number((fields.find((f) => f.no === no)?.value as bigint) || 0n);
const bytes = (fields: Field[], no: number) => fields.find((f) => f.no === no)?.value as Uint8Array | undefined;
const packed = (fields: Field[], no: number) => fields.filter((f) => f.no === no).flatMap((f) => {
  if (f.wire === 0) return [Number(f.value)];
  const list: number[] = [];
  let pos = 0;
  const buf = f.value as Uint8Array;
  while (pos < buf.length) {
    const [v, next] = readVarint(buf, pos);
    list.push(Number(v));
    pos = next;
  }
  return list;
});

function varint(value: number | bigint): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

function encode(fields: [number, number | boolean | Uint8Array | number[] | undefined][]): Uint8Array {
  const out: number[] = [];
  fields.forEach(([no, value]) => {
    if (value === undefined || value === false || value === 0) return;
    if (value instanceof Uint8Array) {
      out.push(...varint((no << 3) | 2), ...varint(value.length), ...value);
    } else if (Array.isArray(value)) {
      if (!value.length) return;
      const body = value.flatMap((v) => varint(v));
      out.push(...varint((no << 3) | 2), ...varint(body.length), ...body);
    } else {
      out.push(...varint(no << 3), ...varint(value === true ? 1 : value));
    }
  });
  return new Uint8Array(out);
}

type Rec = { seq: number; opId: Uint8Array; ct: Uint8Array; chunk: boolean };
type Point = { id: number; upto: number; summary: number; chunks: number[]; created: number };

function createServer() {
  let records: Rec[] = [];
  let lastSeq = 0;
  let point: Point | undefined;
  const commits: Point[] = [];

  const recordBytes = (r: Rec) => encode([[1, r.seq], [2, r.opId], [3, r.ct], [4, r.chunk]]);
  const pointBytes = (p: Point) => encode([[1, p.id], [2, p.upto], [3, p.summary], [4, p.chunks], [5, p.created]]);

  function call(method: string, body: Uint8Array): Promise<Uint8Array> {
    const f = decodeFields(body);
    if (method === 'history.append') {
      const opId = bytes(f, 1)!;
      const ct = bytes(f, 2)!;
      const chunk = num(f, 3) === 1;
      const same = records.find((r) => r.opId.join() === opId.join());
      if (same) {
        if (same.ct.join() !== ct.join()) return Promise.reject(new V2Error('ERROR_CODE_DUPLICATE'));
        return Promise.resolve(encode([[1, same.seq]]));
      }
      const rec = { seq: ++lastSeq, opId: opId.slice(), ct: ct.slice(), chunk };
      records.push(rec);
      return Promise.resolve(encode([[1, rec.seq]]));
    }
    if (method === 'history.sync') {
      let after = num(f, 1);
      const skipChunks = num(f, 3) === 1;
      const compacted = point && after < point.upto ? point : undefined;
      if (compacted) after = compacted.upto;
      const list = records.filter((r) => r.seq > after && !(skipChunks && r.chunk));
      const fields: [number, number | boolean | Uint8Array | number[] | undefined][] = list
        .map((r) => [1, recordBytes(r)]);
      fields.push([3, lastSeq]);
      if (compacted) fields.push([4, pointBytes(compacted)]);
      return Promise.resolve(encode(fields));
    }
    if (method === 'history.head') {
      return Promise.resolve(encode([[1, lastSeq], [2, point ? pointBytes(point) : undefined]]));
    }
    if (method === 'history.get') {
      const seqs = packed(f, 1);
      const list = seqs.map((seq) => records.find((r) => r.seq === seq)).filter((r): r is Rec => Boolean(r));
      return Promise.resolve(encode(list.map((r) => [1, recordBytes(r)])));
    }
    if (method === 'history.checkpoint.commit') {
      const expected = num(f, 1);
      if (expected !== (point?.id || 0)) return Promise.reject(new V2Error('ERROR_CODE_DUPLICATE'));
      const next: Point = {
        id: (point?.id || 0) + 1, upto: num(f, 2), summary: num(f, 3), chunks: packed(f, 4), created: Date.now(),
      };
      const keep = new Set([next.summary, ...next.chunks]);
      records = records.filter((r) => r.seq > next.upto || keep.has(r.seq));
      point = next;
      commits.push(next);
      return Promise.resolve(encode([[1, next.id]]));
    }
    return Promise.reject(new V2Error('ERROR_CODE_UNKNOWN_METHOD'));
  }

  return {
    call,
    records: () => records,
    commits,
    point: () => point,
    /** Сервер «откатился»: последние записи пропали, голова меньше. */
    rollback: (count: number) => {
      records = records.slice(0, records.length - count);
      lastSeq = records.at(-1)?.seq || 0;
    },
  };
}

// ── устройство: хранилище строк + журнал ─────────────────────────────────────────────────────────────

function createDevice(client: PvClient, server: ReturnType<typeof createServer>, opts: {
  clock?: { now: number }; initial?: WireStoredMessage[]; state?: HistorySyncState; readUuids?: string[];
} = {}) {
  const records = new Map<string, WireStoredMessage>((opts.initial || []).map((m) => [m.id, m]));
  const marks = new Map<string, unknown>();
  const logs: string[] = [];
  const wiped: string[][] = [];
  let saved: HistorySyncState | undefined = opts.state;
  let outbox: unknown;
  const index = createMessageIndex({
    loadAll: () => Promise.resolve(Array.from(records.values())),
    loadOne: (uuid) => Promise.resolve(records.get(uuid)),
  });
  const clock = opts.clock;
  // Журнал создаётся ниже: хранилище строк обращается к нему лениво
  // eslint-disable-next-line prefer-const
  let journal: ReturnType<typeof createHistoryJournal>;
  const rows = createHistoryRows({
    self: () => SELF,
    domain: () => 'local',
    index,
    loadAll: () => Promise.resolve(Array.from(records.values())),
    saveRecord: (stored) => records.set(stored.id, stored),
    deleteRecord: (uuid) => records.delete(uuid),
    updateOwnJournal: () => undefined,
    flush: () => Promise.resolve(),
    show: () => Promise.resolve(),
    onChatsTouched: () => undefined,
    loadMarks: () => Promise.resolve(Object.fromEntries(marks) as never),
    saveMark: (address, mark) => marks.set(address, mark),
    loadClearedUntil: () => ({}),
    journal: () => journal,
    log: (message) => logs.push(message),
  });
  journal = createHistoryJournal({
    rows,
    loadState: () => Promise.resolve(saved),
    saveState: (value) => {
      saved = value;
      return Promise.resolve();
    },
    loadOutbox: () => Promise.resolve(outbox as never),
    saveOutbox: (value) => {
      outbox = value;
      return Promise.resolve();
    },
    onWiped: (uuids) => wiped.push(uuids),
    takeLegacyReadUuids: () => opts.readUuids || [],
    log: (message) => logs.push(message),
    now: clock ? () => clock.now : undefined,
    random: () => 0,
  });
  const host: HistoryHost = {
    openSession: () => client.historySession(),
    call: (method, body) => server.call(method, body),
    log: (message) => logs.push(message),
  };
  return {
    rows, journal, records, logs, wiped, host, state: () => saved,
  };
}

function account() {
  const first = new PvClient(SELF, 'device-a', 'local');
  first.ensureStateKey();
  const key = new Uint8Array(32).fill(7);
  const state = first.export(key);
  return { first, clone: () => PvClient.importState(state, key) };
}

function text(id: string, from: string, to: string, tsMs: number, body: string): WireStoredMessage {
  return {
    id, from, to, ts: Math.floor(tsMs / 1000), content: { kind: 'text', text: body },
  };
}

const visible = (device: ReturnType<typeof createDevice>) => Array.from(device.records.values())
  .filter((m) => !m.deleted).map((m) => m.id).sort();

async function waitFor(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('не дождались');
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe('журнал истории: два своих устройства и новое (spec 033)', () => {
  it('удаление «только у меня», прочтение и сообщение доходят до нового устройства; повтор не пишется', async () => {
    const server = createServer();
    const { first, clone } = account();
    const a = createDevice(first, server);
    await a.journal.attach(a.host);
    await a.rows.ingest(rowOpFromStored(text(ID1, PEER, SELF, JAN_2026_MS, 'первое'), DIRECT, JAN_2026_MS), {
      source: 'inbox', author: PEER,
    });
    await a.rows.ingest(rowOpFromStored(text(ID2, PEER, SELF, OCT_2026_MS, 'второе'), DIRECT, OCT_2026_MS), {
      source: 'own',
    });
    await a.rows.ingest({ gone: { target: ID1, chat: DIRECT, stamp: newStamp(), scope: 'GONE_SCOPE_ME' } }, {
      source: 'own',
    });
    await a.rows.advanceMark(PEER, OCT_2026_MS, ID2);
    // Входящее пишется через 1–5 с — для проверки отправляем всё сразу
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    await a.journal.flushNow();
    expect(server.records().length).toBeGreaterThan(0);

    const b = createDevice(clone(), server);
    await b.journal.attach(b.host);
    expect(visible(b)).toEqual([ID2]);
    expect(b.records.get(ID1)?.deleted).toBe(true);
    expect(b.rows.getMark(PEER)?.up_to_id).toBe(ID2);
    expect(b.rows.isUnread({ id: ID2, chat: PEER, from: PEER, tsMs: OCT_2026_MS, kind: 'text' })).toBe(false);

    // То же сообщение пришло инбоксом и на B — уже есть в журнале: B его второй раз не пишет
    const before = server.records().length;
    await b.rows.ingest(rowOpFromStored(text(ID2, PEER, SELF, OCT_2026_MS, 'второе'), DIRECT, OCT_2026_MS), {
      source: 'inbox', author: PEER,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    await b.journal.flushNow();
    expect(server.records().length).toBe(before);
    a.journal.reset();
    b.journal.reset();
  });

  it('перенос локальной истории (один раз) с маркерами прежнего учёта прочитанного', async () => {
    const server = createServer();
    const { first, clone } = account();
    const a = createDevice(first, server, {
      initial: [text(ID1, PEER, SELF, JAN_2026_MS, 'старое'), text(ID2, PEER, SELF, OCT_2026_MS, 'новое')],
      readUuids: [ID1],
    });
    await a.journal.attach(a.host);
    await waitFor(() => Boolean(a.state()?.migrated));
    // Маркер — очередью (≤ 1 с)
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    await a.journal.flushNow();
    const b = createDevice(clone(), server);
    await b.journal.attach(b.host);
    expect(visible(b)).toEqual([ID1, ID2]);
    expect(b.rows.getMark(PEER)?.up_to_id).toBe(ID1);
    expect(b.rows.isUnread({ id: ID2, chat: PEER, from: PEER, tsMs: OCT_2026_MS, kind: 'text' })).toBe(true);
    a.journal.reset();
    b.journal.reset();
  });

  it('контрольная точка: новое устройство входит по ней, неизменившийся сегмент не перезаливается', async () => {
    const server = createServer();
    const clock = { now: OCT_2026_MS + DAY_MS };
    const { first, clone } = account();
    const a = createDevice(first, server, { clock });
    await a.journal.attach(a.host);
    await a.rows.ingest(rowOpFromStored(text(ID1, PEER, SELF, JAN_2026_MS, 'январь'), DIRECT, JAN_2026_MS), {
      source: 'own',
    });
    await a.rows.ingest(rowOpFromStored(text(ID2, PEER, SELF, OCT_2026_MS, 'октябрь'), DIRECT, OCT_2026_MS), {
      source: 'own',
    });
    const stamp = newStamp(OCT_2026_MS);
    await a.rows.ingest({ gone: { target: ID2, chat: DIRECT, stamp, scope: 'GONE_SCOPE_EVERYONE' } }, {
      source: 'own',
    });
    clock.now += 1000;
    await a.journal.flushNow();
    // Смена ключа этим устройством — принудительная точка (сегменты под текущим ключом)
    await a.journal.attach(a.host, 'self');
    await waitFor(() => server.commits.length === 1);
    const firstPoint = server.point()!;
    expect(firstPoint.chunks.length).toBe(2);
    // Записи до точки свёрнуты: остались сегменты и сводка
    expect(server.records().every((r) => r.chunk)).toBe(true);

    const c = createDevice(clone(), server);
    await c.journal.attach(c.host);
    expect(visible(c)).toEqual([ID1]);
    expect(c.records.get(ID2)?.deleted).toBe(true);
    expect(c.state()?.checkpointId).toBe(firstPoint.id);

    // Через сутки и с новой записью — следующая точка; январский сегмент прежним номером
    await a.rows.ingest(rowOpFromStored(text(ID3, PEER, SELF, OCT_2026_MS + 5, 'ещё'), DIRECT, OCT_2026_MS + 5), {
      source: 'own',
    });
    clock.now += 1000;
    await a.journal.flushNow();
    clock.now += 2 * DAY_MS;
    await a.journal.syncNow();
    await waitFor(() => server.commits.length === 2);
    const second = server.point()!;
    const reused = firstPoint.chunks.filter((seq) => second.chunks.includes(seq));
    expect(reused.length).toBe(1);
    a.journal.reset();
    c.journal.reset();
  });

  it('откат сервера: журнал с меньшей головой не применяется', async () => {
    const server = createServer();
    const { first, clone } = account();
    const a = createDevice(first, server);
    await a.journal.attach(a.host);
    await a.rows.ingest(rowOpFromStored(text(ID1, PEER, SELF, JAN_2026_MS, 'раз'), DIRECT, JAN_2026_MS), {
      source: 'own',
    });
    await a.rows.ingest(rowOpFromStored(text(ID2, PEER, SELF, OCT_2026_MS, 'два'), DIRECT, OCT_2026_MS), {
      source: 'own',
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 400);
    });
    await a.journal.flushNow();
    const b = createDevice(clone(), server);
    await b.journal.attach(b.host);
    const head = b.state()!.headSeq;
    server.rollback(1);
    await b.journal.syncNow();
    expect(b.logs.some((line) => line.includes('назад'))).toBe(true);
    expect(b.state()!.headSeq).toBe(head);
    a.journal.reset();
    b.journal.reset();
  });

  it('дольше горизонта надгробий без синхронизации — история заменяется точкой', async () => {
    const server = createServer();
    const clock = { now: OCT_2026_MS };
    const { first, clone } = account();
    const a = createDevice(first, server, { clock });
    await a.journal.attach(a.host);
    await a.rows.ingest(rowOpFromStored(text(ID1, PEER, SELF, JAN_2026_MS, 'раз'), DIRECT, JAN_2026_MS), {
      source: 'own',
    });
    clock.now += 1000;
    await a.journal.flushNow();
    await a.journal.attach(a.host, 'self');
    await waitFor(() => server.commits.length === 1);
    // Устройство B последний раз синхронизировалось год назад и с курсором до точки
    const b = createDevice(clone(), server, {
      initial: [text(ID3, PEER, SELF, JAN_2026_MS, 'устаревшее')],
      state: {
        cursor: 0, headSeq: 0, lastFullSyncMs: OCT_2026_MS - 365 * DAY_MS, migrated: true, checkpointId: -1,
      },
    });
    await b.journal.attach(b.host);
    expect(b.wiped.length).toBe(1);
    expect(visible(b)).toEqual([ID1]);
    a.journal.reset();
    b.journal.reset();
  });
});
