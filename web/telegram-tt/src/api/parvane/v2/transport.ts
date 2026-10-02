// Протокол v2 (spec 007, T055): двоичное WebSocket-соединение с gateway.
// Кадры собирает и разбирает только движок (WASM); здесь — ввод-вывод:
// Hello/Welcome, Auth, Request/Response, Event, StreamChunk, Ping.

import type { Protocol } from './engine';

export const CHANNEL_IDENTIFIED = 1;
export const CHANNEL_ANONYMOUS = 2;

const DEFAULT_TIMEOUT_MS = 15000;

/** Ошибка метода: код протокола (ERROR_CODE_*) и пауза до повтора. */
export class V2Error extends Error {
  constructor(public readonly code: string, public readonly retryAfterMs = 0) {
    super(code);
  }
}

type Pending = {
  resolve: (body: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  chunks?: (chunk: { index: number; last: boolean; data: Uint8Array; error?: string }) => void;
};

export type V2Event = { subscription: number; eventKind: string; seq: number; body: Uint8Array };

type Frame = {
  kind: string;
  id?: number;
  ok?: Uint8Array;
  error?: string;
  retryAfterMs?: number;
  user?: string;
  deviceId?: string;
  serverDescriptor?: Uint8Array;
  features?: string;
  subscription?: number;
  eventKind?: string;
  seq?: number;
  body?: Uint8Array;
  index?: number;
  last?: boolean;
  data?: Uint8Array;
  nonce?: number;
};

export class V2Connection {
  private ws?: WebSocket;

  private nextId = 1;

  private pending = new Map<number, Pending>();

  private waiter?: { kind: string; resolve: (f: Frame) => void; reject: (e: Error) => void };

  onEvent?: (e: V2Event) => void;

  onClose?: () => void;

  constructor(private readonly pv: Protocol, private readonly url: string, private readonly channel: number) {}

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Открыть соединение и пройти Hello/Welcome. Возвращает описатель сервера. */
  connect(clientVersion: string): Promise<{ serverDescriptor: Uint8Array; features: string[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        this.waitFor('welcome').then((f) => {
          settled = true;
          resolve({
            serverDescriptor: f.serverDescriptor || new Uint8Array(),
            features: (f.features || '').split(',').filter(Boolean),
          });
        }, (e: Error) => {
          settled = true;
          reject(e);
        });
        ws.send(new Uint8Array(this.pv.encodeHello(this.channel, 'web', clientVersion)));
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`v2 gateway недоступен: ${this.url}`));
        }
      };
      ws.onclose = () => {
        const err = new Error('v2: соединение закрыто');
        this.pending.forEach((p) => {
          clearTimeout(p.timer);
          p.reject(err);
        });
        this.pending.clear();
        this.waiter?.reject(err);
        this.waiter = undefined;
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.onClose?.();
      };
      ws.onmessage = (m) => {
        if (!(m.data instanceof ArrayBuffer)) return;
        this.handle(new Uint8Array(m.data));
      };
    });
  }

  /** Auth с JWT (claim dev обязателен). */
  async auth(token: string): Promise<{ user: string; deviceId: string }> {
    const waiting = this.waitFor('authOk');
    this.ws?.send(new Uint8Array(this.pv.encodeAuth(token)));
    const f = await waiting;
    return { user: f.user || '', deviceId: f.deviceId || '' };
  }

  /** Метод реестра: тело запроса (protobuf) → тело ответа. */
  request(method: string, body: Uint8Array, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Uint8Array> {
    return this.send(method, body, timeoutMs);
  }

  /** Поточный метод (скачивание): метаданные + чанки через колбэк. */
  stream(
    method: string,
    body: Uint8Array,
    onChunk: (chunk: { index: number; last: boolean; data: Uint8Array; error?: string }) => void,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    return this.send(method, body, timeoutMs, onChunk);
  }

  close() {
    this.ws?.close();
  }

  private send(
    method: string,
    body: Uint8Array,
    timeoutMs: number,
    chunks?: Pending['chunks'],
  ): Promise<Uint8Array> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new V2Error('ERROR_CODE_UNAVAILABLE'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new V2Error('ERROR_CODE_UNAVAILABLE'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve, reject, timer, chunks,
      });
      ws.send(new Uint8Array(this.pv.encodeRequest(BigInt(id), method, body, Math.min(timeoutMs, 30000))));
    });
  }

  private waitFor(kind: string): Promise<Frame> {
    return new Promise((resolve, reject) => {
      this.waiter = { kind, resolve, reject };
    });
  }

  private handle(bytes: Uint8Array) {
    let f: Frame;
    try {
      f = this.pv.decodeFrame(bytes) as Frame;
    } catch {
      return;
    }
    if (this.waiter && (f.kind === this.waiter.kind || (f.kind === 'response' && f.id === 0))) {
      const w = this.waiter;
      this.waiter = undefined;
      if (f.kind === 'response') w.reject(new V2Error(f.error || 'ERROR_CODE_UNSPECIFIED'));
      else w.resolve(f);
      return;
    }
    switch (f.kind) {
      case 'response': {
        const p = this.pending.get(Number(f.id));
        if (!p) return;
        if (f.error) {
          clearTimeout(p.timer);
          this.pending.delete(Number(f.id));
          p.reject(new V2Error(f.error, f.retryAfterMs));
          return;
        }
        if (!p.chunks) {
          clearTimeout(p.timer);
          this.pending.delete(Number(f.id));
        }
        p.resolve(f.ok || new Uint8Array());
        return;
      }
      case 'chunk': {
        const p = this.pending.get(Number(f.id));
        if (!p?.chunks) return;
        p.chunks({
          index: f.index || 0, last: Boolean(f.last), data: f.data || new Uint8Array(), error: f.error,
        });
        if (f.last) {
          clearTimeout(p.timer);
          this.pending.delete(Number(f.id));
        }
        return;
      }
      case 'event':
        this.onEvent?.({
          subscription: Number(f.subscription),
          eventKind: f.eventKind || '',
          seq: Number(f.seq),
          body: f.body || new Uint8Array(),
        });
        return;
      case 'ping':
        // Сервер пингует редко; ответ собирает движок.
        return;
      default:
    }
  }
}
