import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';
import { ApiMediaFormat } from '../types';

import * as mediaLoader from '../../util/mediaLoader';
import { encryptBlob } from './blobcrypt';
import { createMediaService } from './media';

// `util/browser/windowEnvironment.ts` (его тянет mediaLoader) опрашивает на
// импорте matchMedia и CSS.supports, которых в jsdom нет
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  window.CSS = { ...(window.CSS || {}), supports: () => false };
});

// `util/mediaLoader.ts` ходит в провайдер за медиа — в этом файле он не нужен:
// проверяем только его собственные кэши
vi.mock('../gramjs', () => ({
  callApi: (_method: string, { url }: { url: string }) => Promise.resolve(
    url.includes('f-tampered')
      ? { error: 'MEDIA_INTEGRITY' }
      : { dataBlob: new Blob(['media-bytes']), mimeType: 'image/jpeg' },
  ),
  cancelApiProgress: () => undefined,
}));

// Фоновая проверка целостности и эталоны фрагментов не зависят от кэша окон:
// фрагмент, вытесненный из кэша (лимит 96 фрагментов на файл), при повторной
// выдаче с другими байтами — провал целостности (spec 002 SC-006, FR-022)

const CHUNK_BYTES = 64;
const TOTAL_CHUNKS = 120; // больше лимита кэша фрагментов одного файла
const FILE_ID = 'f-evict';
const PROGRESSIVE = 1;

type Server = {
  chunks: Uint8Array[];
  tampered: Map<number, Uint8Array>;
  requested: Array<[number, number]>;
};

function toBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function setup() {
  const plain = crypto.getRandomValues(new Uint8Array(CHUNK_BYTES * TOTAL_CHUNKS - 16));
  const { ciphertext, keyB64, nonceB64 } = await encryptBlob(plain);
  const server: Server = { chunks: [], tampered: new Map(), requested: [] };
  for (let index = 0; index < TOTAL_CHUNKS; index++) {
    server.chunks.push(ciphertext.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
  }
  const connection = {
    isOpen: true,
    requestMany: (_subject: string, payload: string) => {
      const { payload: body } = JSON.parse(payload) as { payload: { chunk_from: number; chunk_to: number } };
      server.requested.push([body.chunk_from, body.chunk_to]);
      const replies: string[] = [];
      for (let index = body.chunk_from; index <= body.chunk_to; index++) {
        replies.push(JSON.stringify({
          ok: true,
          chunk_index: index,
          total_chunks: TOTAL_CHUNKS,
          size_bytes: ciphertext.length,
          chunk_bytes: CHUNK_BYTES,
          data: toBase64(server.tampered.get(index) || server.chunks[index]),
        }));
      }
      return Promise.resolve(replies);
    },
  } as unknown as GatewayConnection;
  const service = createMediaService({
    getConnection: () => connection,
    getStore: () => ({ self: 'bob@local' }) as unknown as ParvaneStore,
    getToken: () => 'token',
  });
  service.rememberKeys({
    kind: 'video',
    file_id: FILE_ID,
    file_key: keyB64,
    file_nonce: nonceB64,
    mime: 'video/mp4',
    size_bytes: plain.length,
  });
  const readChunk = (index: number) => service.downloadMedia({
    url: `http://127.0.0.1/progressive/document${FILE_ID}`,
    mediaFormat: PROGRESSIVE,
    start: index * CHUNK_BYTES,
    end: index * CHUNK_BYTES + CHUNK_BYTES - 1,
  }) as Promise<{ arrayBuffer?: ArrayBuffer; error?: string } | undefined>;
  return {
    plain, server, service, readChunk,
  };
}

function flipped(bytes: Uint8Array) {
  const copy = bytes.slice();
  copy[5] ^= 0xff;
  return copy;
}

describe('media integrity after chunk cache eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches an evicted chunk with the same bytes without flagging the file', async () => {
    const { plain, server, service, readChunk } = await setup();
    for (let index = 0; index <= 100; index++) await readChunk(index);
    const before = server.requested.length;
    const again = await readChunk(0);
    expect(server.requested.length).toBe(before + 1); // чанк 0 вытеснен — снова из сети
    expect(new Uint8Array(again!.arrayBuffer!)).toEqual(plain.slice(0, CHUNK_BYTES));
    expect(service.isTampered(FILE_ID)).toBe(false);
  });

  it('flags the file when an evicted chunk comes back with different bytes', async () => {
    const { server, service, readChunk } = await setup();
    for (let index = 0; index <= 100; index++) await readChunk(index);
    server.tampered.set(0, flipped(server.chunks[0]));
    const result = await readChunk(0);
    expect(result?.error).toBeTruthy();
    expect(service.isTampered(FILE_ID)).toBe(true);
    // Повторный запуск — ошибка без новых запросов файла
    const requests = server.requested.length;
    expect((await readChunk(3))?.error).toBeTruthy();
    expect(server.requested.length).toBe(requests);
  });

  it('background verification catches a chunk tampered after the player saw it and it was evicted', async () => {
    const { server, service, readChunk } = await setup();
    for (let index = 0; index <= 100; index++) await readChunk(index);
    server.tampered.set(2, flipped(server.chunks[2]));
    // Задача стартует через 5 с после окна плеера и докачивает шифртекст целиком
    for (let step = 0; step < 400 && !service.isTampered(FILE_ID); step++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(service.isTampered(FILE_ID)).toBe(true);
    expect(server.requested.some(([from, to]) => from <= 2 && to >= 2 && to - from > 0)).toBe(true);
  });

  // FR-022: после подмены расшифрованных байт не должно остаться нигде. Запись
  // в памяти mediaLoader'а держит object-URL, который уже роздан `<img src>` и
  // `<video src>`: пока URL не отозван, элементы продолжают показывать
  // подменённые данные. Отзыв — только на этом пути: вытеснение по бюджету
  // (T150) отзывать не имеет права, там URL живой и нужный
  it('revokes object URLs of the tampered file and leaves other files alone', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => {
      const objectUrl = `blob:parvane/${created.length}`;
      created.push(objectUrl);
      return objectUrl;
    };
    URL.revokeObjectURL = (objectUrl: string) => {
      revoked.push(objectUrl);
    };
    try {
      const fullUrl = `document${FILE_ID}`;
      const thumbUrl = `document${FILE_ID}?size=x`;
      const otherUrl = 'documentf-intact';
      const full = await mediaLoader.fetch(fullUrl, ApiMediaFormat.BlobUrl);
      const thumb = await mediaLoader.fetch(thumbUrl, ApiMediaFormat.BlobUrl);
      const other = await mediaLoader.fetch(otherUrl, ApiMediaFormat.BlobUrl);

      mediaLoader.unloadByFileId(FILE_ID);

      expect([...revoked].sort()).toEqual([full, thumb].sort());
      expect(mediaLoader.getFromMemory(fullUrl)).toBeUndefined();
      expect(mediaLoader.getFromMemory(thumbUrl)).toBeUndefined();
      // Чужой файл не тронут ни записью, ни отзывом
      expect(mediaLoader.getFromMemory(otherUrl)).toBe(other);
      expect(revoked).not.toContain(other);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  // Отказ проверки целостности приходит на ЛЮБОМ формате, не только на
  // progressive: раньше объект `{error}` шёл дальше как медиа, и в памяти
  // оседал `undefined` — вечный спиннер вместо ошибки (spec 002 FR-022)
  it('does not remember an integrity failure as media', async () => {
    const url = 'documentf-tampered';
    await expect(mediaLoader.fetch(url, ApiMediaFormat.BlobUrl)).resolves.toBeUndefined();
    expect(mediaLoader.getFromMemory(url)).toBeUndefined();
  });

  it('background verification fetches a whole intact file larger than the chunk cache', async () => {
    const { server, service, readChunk } = await setup();
    for (let index = 0; index <= 100; index++) await readChunk(index);
    const requestsBefore = server.requested.length;
    // Старт задачи — по фейковому таймеру; докачка и GHASH идут на WebCrypto,
    // поэтому ждём в реальном времени (таймер простоя остаётся фейковым)
    await vi.advanceTimersByTimeAsync(5100);
    vi.useRealTimers();
    const batches = Math.ceil(TOTAL_CHUNKS / 24);
    const deadline = Date.now() + 5000;
    while (server.requested.length < requestsBefore + batches && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    const jobRequests = server.requested.slice(requestsBefore);
    expect(jobRequests).toEqual(Array.from({ length: batches }, (_, batch) => [
      batch * 24, Math.min(TOTAL_CHUNKS - 1, batch * 24 + 23),
    ]));
    expect(service.isTampered(FILE_ID)).toBe(false);
  });
});
