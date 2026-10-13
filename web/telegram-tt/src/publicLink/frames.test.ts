import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  decodeFrame as engineDecodeFrame, decodeMessage, encodeHello as engineEncodeHello, encodeMessage,
  encodePing as engineEncodePing, encodeRequest as engineEncodeRequest, initSync,
} from '../lib/parvane-protocol/parvane_protocol';
import {
  CHANNEL_ANONYMOUS, concatBytes, decodeFrame, encodeHello, encodePong, encodeRequest, fieldBytes, fieldString,
  fieldVarint, FrameError, varint,
} from './frames';
import {
  decodeLinkDownloadResponse, decodeLinkGetResponse, encodeLinkDownloadRequest, encodeLinkGetRequest,
} from './linkProto';

// Parvane (spec 022): мини-кодек публичной страницы сверяется с движком —
// байты Hello и Request равны байтам движка, а кадры сервера, собранные здесь
// вручную, движок принимает и читает так же, как мини-кодек.
const WASM = path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm');

type EngineFrame = {
  kind: string; id?: number; ok?: Uint8Array; error?: string; retryAfterMs?: number; features?: string;
  serverDescriptor?: Uint8Array; index?: number; last?: boolean; data?: Uint8Array; nonce?: number;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const utf8 = (text: string) => new TextEncoder().encode(text);

// Кадры сервера (их движок в WASM не собирает): Frame{proto_major = 1, <вид> = N}
const serverFrame = (field: number, body: Uint8Array) => concatBytes([
  fieldVarint(1, 2), fieldBytes(field, body, true),
]);
const errorBody = (code: number, retryAfterMs = 0) => concatBytes([fieldVarint(1, code), fieldVarint(2, retryAfterMs)]);
const welcomeFrame = (features: string[], descriptor: Uint8Array) => serverFrame(11, concatBytes([
  fieldVarint(2, 2), ...features.map((f) => fieldString(4, f)), fieldBytes(5, descriptor),
]));
const responseOk = (id: number, body: Uint8Array) => serverFrame(21, concatBytes([
  fieldVarint(1, id), fieldBytes(2, body, true),
]));
const responseError = (id: number, code: number, retryAfterMs = 0) => serverFrame(21, concatBytes([
  fieldVarint(1, id), fieldBytes(3, errorBody(code, retryAfterMs), true),
]));
const chunkFrame = (id: number, index: number, last: boolean, data: Uint8Array, error?: Uint8Array) => serverFrame(
  23,
  concatBytes([
    fieldVarint(1, id), fieldVarint(2, index), fieldVarint(3, last ? 1 : 0), fieldBytes(4, data),
    error ? fieldBytes(5, error, true) : new Uint8Array(0),
  ]),
);

describe('публичная страница ссылки: кодек кадров v2 против движка', () => {
  initSync({ module: readFileSync(WASM) });

  it('Hello анонимного канала — байт в байт', () => {
    expect(hex(encodeHello(CHANNEL_ANONYMOUS, 'web', '12.0.21')))
      .toBe(hex(engineEncodeHello(CHANNEL_ANONYMOUS, 'web', '12.0.21')));
    expect(hex(encodeHello(1, 'web', ''))).toBe(hex(engineEncodeHello(1, 'web', '')));
  });

  it('Request — байт в байт, включая пустое тело и большие идентификаторы', () => {
    const body = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
    const cases: [number, string, Uint8Array, number][] = [
      [1, 'cloud.blob.download_cap', body, 30000],
      [1, 'cloud.blob.usage', new Uint8Array(0), 20000],
      [127, 'x', Uint8Array.from([0]), 1],
      [128, 'msg.inbox.sync', body, 0],
      [2 ** 40 + 5, 'cloud.blob.download_cap', body.subarray(0, 127), 16384],
    ];
    cases.forEach(([id, method, bytes, timeoutMs]) => {
      expect(hex(encodeRequest(id, method, bytes, timeoutMs)))
        .toBe(hex(engineEncodeRequest(BigInt(id), method, bytes, timeoutMs)));
    });
  });

  it('тело запроса: примитивы кодека дают те же байты, что кодек сообщений движка', () => {
    // LinkDownloadRequest{link_id, file_id, first_chunk, chunk_count} по раскладке совпадает с
    // DownloadCapRequest{file_id, capability (bytes), first_chunk, chunk_count}
    const mine = encodeLinkDownloadRequest('AbCdEfGhIjKlMnOpQrStUv', 'файл-7', 3, 32);
    const engine = encodeMessage('parvane.cloud.v1.DownloadCapRequest', JSON.stringify({
      file_id: 'AbCdEfGhIjKlMnOpQrStUv', capability: base64(utf8('файл-7')), first_chunk: 3, chunk_count: 32,
    }));
    expect(hex(mine)).toBe(hex(engine));
    // Нулевые значения не пишутся
    expect(hex(encodeLinkDownloadRequest('id', 'f', 0, 0))).toBe(hex(encodeMessage(
      'parvane.cloud.v1.DownloadCapRequest', JSON.stringify({ file_id: 'id', capability: base64(utf8('f')) }),
    )));
  });

  it('тело ответа: числа читаются так же, как у движка', () => {
    // LinkDownloadResponse{size, chunks} по раскладке совпадает с DownloadCapResponse
    const bytes = concatBytes([fieldVarint(1, 5 * 1024 * 1024 * 1024 + 17), fieldVarint(2, 9999)]);
    const engine = JSON.parse(decodeMessage('parvane.cloud.v1.DownloadCapResponse', bytes)) as {
      size: string; chunks: number;
    };
    const mine = decodeLinkDownloadResponse(bytes);
    expect(mine.size).toBe(Number(engine.size));
    expect(mine.chunks).toBe(engine.chunks);
    expect(decodeLinkDownloadResponse(new Uint8Array(0))).toEqual({ size: 0, chunks: 0 });
  });

  it('Welcome читается так же, как у движка', () => {
    const descriptor = Uint8Array.from({ length: 200 }, (_, i) => 255 - i);
    const bytes = welcomeFrame(['anon', 'stream'], descriptor);
    const engine = engineDecodeFrame(bytes) as EngineFrame;
    const mine = decodeFrame(bytes);
    expect(engine.kind).toBe('welcome');
    expect(mine.kind).toBe('welcome');
    if (mine.kind !== 'welcome') return;
    expect(mine.features.join(',')).toBe(engine.features);
    expect(hex(mine.serverDescriptor)).toBe(hex(engine.serverDescriptor!));
  });

  it('Response (ok, пустой ok, ошибка с паузой) читается так же, как у движка', () => {
    const body = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) % 256);
    for (const bytes of [responseOk(1, body), responseOk(300, new Uint8Array(0))]) {
      const engine = engineDecodeFrame(bytes) as EngineFrame;
      const mine = decodeFrame(bytes);
      expect(mine.kind).toBe('response');
      if (mine.kind !== 'response') return;
      expect(mine.id).toBe(engine.id);
      expect(mine.error).toBeUndefined();
      expect(engine.error).toBeUndefined();
      expect(hex(mine.ok!)).toBe(hex(engine.ok!));
    }
    // Все коды ошибок: имена — как у движка
    for (let code = 0; code <= 13; code++) {
      const bytes = responseError(1, code, code === 5 ? 4500 : 0);
      const engine = engineDecodeFrame(bytes) as EngineFrame;
      const mine = decodeFrame(bytes);
      if (mine.kind !== 'response') throw new Error('не response');
      expect(mine.ok).toBeUndefined();
      expect(mine.error).toBe(engine.error);
      expect(mine.retryAfterMs).toBe(engine.retryAfterMs);
    }
    const limited = decodeFrame(responseError(1, 5, 4500));
    expect(limited).toMatchObject({ error: 'ERROR_CODE_RATE_LIMITED', retryAfterMs: 4500 });
    expect(decodeFrame(responseError(0, 3))).toMatchObject({ id: 0, error: 'ERROR_CODE_NOT_FOUND' });
  });

  it('StreamChunk читается так же, как у движка', () => {
    const data = Uint8Array.from({ length: 512 * 1024 }, (_, i) => (i * 31) % 256);
    const frames = [
      chunkFrame(1, 0, false, data),
      chunkFrame(1, 31, true, data.subarray(0, 1000)),
      chunkFrame(1, 0, true, new Uint8Array(0), errorBody(11)),
    ];
    frames.forEach((bytes) => {
      const engine = engineDecodeFrame(bytes) as EngineFrame;
      const mine = decodeFrame(bytes);
      expect(engine.kind).toBe('chunk');
      if (mine.kind !== 'chunk') throw new Error('не chunk');
      expect(mine.id).toBe(engine.id);
      expect(mine.index).toBe(engine.index);
      expect(mine.last).toBe(engine.last);
      expect(hex(mine.data)).toBe(hex(engine.data!));
      expect(mine.error).toBe(engine.error);
    });
    expect(decodeFrame(frames[2])).toMatchObject({ last: true, error: 'ERROR_CODE_UNAVAILABLE' });
  });

  it('Ping движка читается, Pong — законный кадр', () => {
    const ping = decodeFrame(engineEncodePing(BigInt(77)));
    expect(ping).toEqual({ kind: 'ping', nonce: 77 });
    // Движок разбирает кадры сервера; Pong того же вида он узнаёт по полю
    expect((engineDecodeFrame(encodePong(77)) as EngineFrame)).toMatchObject({ kind: 'pong', nonce: 77 });
  });

  it('негодные кадры отвергаются, незнакомые поля пропускаются', () => {
    expect(() => decodeFrame(Uint8Array.from([0x08, 0x03, 0x5a, 0x00]))).toThrow(FrameError);
    expect(() => decodeFrame(Uint8Array.from([0x08, 0x02, 0xaa, 0x01, 0x05, 0x01]))).toThrow(FrameError);
    expect(() => decodeFrame(Uint8Array.from([0x0b]))).toThrow(FrameError);
    // Вектор кодека `unknown-field-skipped`
    expect(decodeFrame(Uint8Array.from([0x08, 0x02, 0x62, 0x00, 0xf8, 0x3e, 0x01])).kind).toBe('unknown');
    const withUnknown = concatBytes([responseOk(1, utf8('ok')), fieldVarint(999, 5)]);
    expect(decodeFrame(withUnknown)).toMatchObject({ kind: 'response', id: 1 });
    expect(hex(varint(300))).toBe('ac02');
    expect(() => varint(-1)).toThrow(FrameError);
  });
});

describe('публичная страница ссылки: сообщения cloud.link.*', () => {
  // TODO после пересборки WASM: сверить с движком байты LinkGetRequest / LinkDownloadRequest
  // (`encodeMethodRequest('cloud.link.get' | 'cloud.link.download', …)`) и разбор LinkGetResponse /
  // LinkDownloadResponse (`decodeMethodResponse`). Старый WASM этих методов не знает; пока — номера
  // полей по контракту `specs/022-public-links/contracts/links.md` и самосогласованность кодека.
  it('LinkGetRequest: link_id — поле 1', () => {
    expect(hex(encodeLinkGetRequest('AbCdEfGhIjKlMnOpQrStUv')))
      .toBe(`0a16${hex(utf8('AbCdEfGhIjKlMnOpQrStUv'))}`);
  });

  it('LinkGetResponse: manifest = 1, expires_at = 2, expired = 3', () => {
    const manifest = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);
    const active = decodeLinkGetResponse(concatBytes([fieldBytes(1, manifest), fieldVarint(2, 1791840000)]));
    expect(hex(active.manifest)).toBe(hex(manifest));
    expect(active.expiresAt).toBe(1791840000);
    expect(active.expired).toBe(false);
    expect(decodeLinkGetResponse(fieldVarint(3, 1))).toEqual({
      manifest: new Uint8Array(0), expiresAt: 0, expired: true,
    });
  });

  it('LinkDownloadRequest: link_id = 1, file_id = 2, first_chunk = 3, chunk_count = 4', () => {
    expect(hex(encodeLinkDownloadRequest('L', 'F', 1, 2))).toBe('0a014c12014618012002');
  });
});
