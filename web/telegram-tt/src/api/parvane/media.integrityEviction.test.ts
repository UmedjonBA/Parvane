import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';
import { ApiMediaFormat } from '../types';

import * as mediaLoader from '../../util/mediaLoader';
import { encryptBlobWithKey } from './blobcrypt';
import { createMediaService } from './media';

// `util/browser/windowEnvironment.ts` (его тянет mediaLoader) опрашивает на
// импорте matchMedia и CSS.supports, которых в jsdom нет
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  window.CSS = { ...(window.CSS || {}), supports: () => false };
});

// Свой блоб без секрета качается методом v2 `cloud.blob.download` через мост
// (`getV2Bridge().control.downloadChunks`) — здесь его подменяет сервер теста
const bridge = vi.hoisted(() => ({
  downloadChunks: undefined as undefined | ((fileId: string, firstChunk: number, chunkCount: number) => Promise<{
    size: number; totalChunks: number; parts: Map<number, Uint8Array>;
  }>),
}));
vi.mock('./gateway', () => ({
  getV2Bridge: () => ({
    control: {
      downloadChunks: (fileId: string, firstChunk: number, chunkCount: number) => (
        bridge.downloadChunks!(fileId, firstChunk, chunkCount)
      ),
    },
  }),
}));

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

// Каждое окно собирается из чанков PVB2 со своим тегом (BLOB-1): фрагмент,
// вытесненный из кэша (лимит 96 фрагментов на файл), при повторной выдаче с
// другими байтами — провал целостности (spec 002 SC-006, FR-022)

const BLOB_CHUNK = 1024; // чанк PVB2 (минимум по BLOB-1)
const PLAIN_CHUNKS = 120;
const CHUNK_BYTES = BLOB_CHUNK + 16; // облачный фрагмент — не кратен чанку PVB2
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
  const plain = new Uint8Array(BLOB_CHUNK * PLAIN_CHUNKS);
  // getRandomValues — не больше 64 КБ за вызов
  for (let offset = 0; offset < plain.length; offset += 65536) {
    crypto.getRandomValues(plain.subarray(offset, offset + 65536));
  }
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await encryptBlobWithKey(plain, rawKey, nonce, BLOB_CHUNK);
  const keyB64 = toBase64(rawKey);
  const nonceB64 = toBase64(nonce);
  // больше лимита кэша фрагментов одного файла
  const TOTAL_CHUNKS = Math.ceil(ciphertext.length / CHUNK_BYTES);
  const server: Server = { chunks: [], tampered: new Map(), requested: [] };
  for (let index = 0; index < TOTAL_CHUNKS; index++) {
    server.chunks.push(ciphertext.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
  }
  bridge.downloadChunks = (_fileId: string, firstChunk: number, chunkCount: number) => {
    const last = Math.min(firstChunk + chunkCount - 1, TOTAL_CHUNKS - 1);
    server.requested.push([firstChunk, last]);
    const parts = new Map<number, Uint8Array>();
    for (let index = firstChunk; index <= last; index++) {
      parts.set(index, server.tampered.get(index) || server.chunks[index]);
    }
    return Promise.resolve({ size: ciphertext.length, totalChunks: TOTAL_CHUNKS, parts });
  };
  const connection = {} as unknown as GatewayConnection;
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
    start: index * BLOB_CHUNK,
    end: index * BLOB_CHUNK + BLOB_CHUNK - 1,
  }) as Promise<{ arrayBuffer?: ArrayBuffer; error?: string } | undefined>;
  return {
    plain, server, service, readChunk,
  };
}

function flipped(bytes: Uint8Array) {
  const copy = bytes.slice();
  copy[20] ^= 0xff; // за заголовком PVB2 — внутри шифртекста чанка 0
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
    expect(new Uint8Array(again!.arrayBuffer!)).toEqual(plain.slice(0, BLOB_CHUNK));
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
});
