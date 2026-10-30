// Правки ревью (fix-030): стойкость транспорта/управляющего соединения v2 и мелкие проверки приёма.
import { readFileSync } from 'fs';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { cleanParticipants } from './callMap';
import { V2Control } from './control';
import { isFinalAppendRejection } from './stateJournal';
import { V2Connection, V2Error } from './transport';

const mocks = vi.hoisted(() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const pv = {
    encodeHello: () => enc.encode(JSON.stringify({ kind: 'hello' })),
    encodeAuth: () => enc.encode(JSON.stringify({ kind: 'auth' })),
    encodeRequest: (id: bigint, method: string) => enc.encode(
      JSON.stringify({ kind: 'request', id: Number(id), method }),
    ),
    decodeFrame: (bytes: Uint8Array) => {
      const f = JSON.parse(dec.decode(bytes)) as Record<string, unknown>;
      if (typeof f.okText === 'string') f.ok = enc.encode(f.okText);
      if (Array.isArray(f.dataArr)) f.data = new Uint8Array(f.dataArr as number[]);
      return f;
    },
    verifyServerDescriptor: () => undefined,
    encodeMethodRequest: (_m: string, json: string) => enc.encode(json),
    decodeMethodResponse: (_m: string, bytes: Uint8Array) => dec.decode(bytes),
  };
  return { pv };
});

vi.mock('./engine', () => ({ loadProtocol: () => Promise.resolve(mocks.pv) }));

type Sent = { kind: string; id?: number; method?: string };

class FakeWs {
  static OPEN = 1;

  static all: FakeWs[] = [];

  static onRequest: (ws: FakeWs, frame: Sent) => void = () => undefined;

  readyState = 1;

  binaryType = '';

  onopen?: () => void;

  onclose?: () => void;

  onerror?: () => void;

  onmessage?: (m: { data: ArrayBuffer }) => void;

  sent: Sent[] = [];

  constructor(public url: string) {
    FakeWs.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: Uint8Array) {
    const f = JSON.parse(new TextDecoder().decode(data)) as Sent;
    this.sent.push(f);
    if (f.kind === 'hello') this.push({ kind: 'welcome', serverDescriptor: [] });
    else if (f.kind === 'auth') this.push({ kind: 'authOk', user: 'u', deviceId: 'd' });
    else FakeWs.onRequest(this, f);
  }

  push(frame: Record<string, unknown>) {
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    // ArrayBuffer именно среды тестов: буфер TextEncoder из другого мира и `instanceof ArrayBuffer` не проходит
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    queueMicrotask(() => this.onmessage?.({ data: buffer }));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeWs.all = [];
  FakeWs.onRequest = () => undefined;
  vi.stubGlobal('WebSocket', FakeWs);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected(): Promise<{ conn: V2Connection; ws: FakeWs }> {
  const conn = new V2Connection(mocks.pv as never, 'ws://t', 1);
  await conn.connect('v2');
  return { conn, ws: FakeWs.all[FakeWs.all.length - 1] };
}

describe('транспорт: тайм-аут потока — бездействие', () => {
  it('чанки продлевают тайм-аут, обрыв сообщает потоку об ошибке сразу', async () => {
    const { conn, ws } = await connected();
    vi.useFakeTimers();
    const chunks: { last: boolean; error?: string }[] = [];
    const reqId = 1;
    const done = conn.stream('m', new Uint8Array(), (c) => chunks.push(c), 1000);
    ws.push({ kind: 'response', id: reqId, okText: '{}' });
    await vi.advanceTimersByTimeAsync(0);
    await done;
    // Каждые 800 мс приходит чанк: общее время больше 1000 мс, но поток жив
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(800);
      ws.push({ kind: 'chunk', id: reqId, index: i, last: false, dataArr: [1] });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(chunks).toHaveLength(3);
    ws.close();
    expect(chunks[chunks.length - 1]).toMatchObject({ last: true, error: 'ERROR_CODE_UNAVAILABLE' });
  });
});

describe('управляющее соединение', () => {
  it('тайм-аут ответа на живом соединении не повторяет запрос', async () => {
    let calls = 0;
    FakeWs.onRequest = (_ws, f) => {
      if (f.kind === 'request') calls += 1;
    };
    const control = new V2Control(() => 'ws://t', () => 'token');
    vi.useFakeTimers();
    const pending = control.call('some.method', {}, 500).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(600);
    const err = await pending;
    expect(err).toBeInstanceOf(V2Error);
    expect(calls).toBe(1);
  });

  it('скачивание: размер сверх предела и чанк вне окна отвергаются', async () => {
    const control = new V2Control(() => 'ws://t', () => 'token');
    FakeWs.onRequest = (ws, f) => {
      ws.push({ kind: 'response', id: f.id, okText: JSON.stringify({ size: '900', chunks: 1 }) });
    };
    await expect(control.downloadChunks('f', 0, 1, 100)).rejects.toMatchObject({ code: 'ERROR_CODE_LIMIT' });

    FakeWs.onRequest = (ws, f) => {
      ws.push({ kind: 'response', id: f.id, okText: JSON.stringify({ size: '1', chunks: 1 }) });
      ws.push({ kind: 'chunk', id: f.id, index: 7, last: true, dataArr: [1] });
    };
    await expect(control.downloadChunks('f', 0, 1)).rejects.toMatchObject({ code: 'ERROR_CODE_INVALID' });
  });

  it('устаревшее открытие после смены токена закрывается и не занимает место соединения', async () => {
    let token = 'a';
    const control = new V2Control(() => 'ws://t', () => token);
    FakeWs.onRequest = (ws, f) => ws.push({ kind: 'response', id: f.id, okText: '{}' });
    const first = control.call('m', {}).catch((e: unknown) => e);
    token = 'b';
    const second = control.call('m', {});
    await second;
    await first;
    // Живым осталось ровно одно соединение — под новым токеном
    expect(FakeWs.all.filter((w) => w.readyState === 1)).toHaveLength(1);
  });
});

describe('мелкие проверки приёма', () => {
  it('приглашение в звонок: адреса без повторов и мусора', () => {
    expect(cleanParticipants(['a@x', 'a@x', '', 'bad', 'sp ace@x', 'b@y', 'c@d@e'])).toEqual(['a@x', 'b@y']);
    expect(cleanParticipants([`${'a'.repeat(300)}@x`])).toEqual([]);
  });

  it('журнал состояния: окончательный отказ снимает запись, сбой связи — нет', () => {
    expect(isFinalAppendRejection(new V2Error('ERROR_CODE_INVALID'))).toBe(true);
    expect(isFinalAppendRejection(new V2Error('ERROR_CODE_FORBIDDEN'))).toBe(true);
    expect(isFinalAppendRejection(new V2Error('ERROR_CODE_UNAVAILABLE'))).toBe(false);
    expect(isFinalAppendRejection(new V2Error('ERROR_CODE_RATE_LIMITED'))).toBe(false);
    expect(isFinalAppendRejection(new Error('network'))).toBe(false);
  });
});

// Сторож по исходникам (как conformance.test.ts): поведение этих мест завязано на таймеры и вкладки браузера
describe('сторож исходников', () => {
  const read = (name: string) => readFileSync(`${__dirname}/${name}`, 'utf8');

  it('L2: возврат на вкладку и открытие раздела не опрашивают сервер вне ритма таймера', () => {
    ['stateJournal.ts', 'planner.ts', 'cloud.ts'].forEach((file) => {
      const src = read(file);
      const handler = src.slice(src.indexOf('addEventListener(\'visibilitychange\''));
      expect(handler.slice(0, 600), file).toContain('isTimerSyncMode()');
    });
    expect(read('planner.ts')).toContain('!isHidden() && !isTimerSyncMode()) void syncNow()');
    expect(read('cloud.ts')).toContain('!isHidden() && !isTimerSyncMode()) void syncNow(true)');
  });

  it('облако: сборка мусора стирает только блобы из локального списка своих загрузок', () => {
    const src = read('cloud.ts');
    expect(src).toContain('!own.has(blob.fileId)');
    expect(read('controller.ts')).toContain('cloud.noteOwnBlob(id)');
  });
});
