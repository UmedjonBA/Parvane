import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import type { CloudNodeJson, CloudStateJson } from './cloudDrive';
import type { CloudSync } from './v2/cloud';

import {
  type BlobSession, type CloudBlobTransport, uploadCloudBlob,
} from './cloudBlobs';
import { createCloudDrive, createSharedSession } from './cloudDrive';

// Разбор дерева по ревизии (A8), серия скачиваний по одному соединению (A9),
// кэш просмотра по байтам и освобождение blob-URL миниатюр (D6/D9)

function unb64(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

/** Мини-шард cloud: загрузки по чанкам, выдача окнами; считает серии и соединения. */
function createServer() {
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const files = new Map<string, Uint8Array[]>();
  const log: string[] = [];
  let sessions = 0;
  let directDownloads = 0;

  const session = (tag: string): BlobSession => ({
    // eslint-disable-next-line @typescript-eslint/require-await
    downloadBlobCap: async (fileId, _capability, firstChunk, chunkCount) => {
      log.push(`${tag} ${fileId}`);
      const list = files.get(fileId);
      if (!list) throw new Error('нет файла');
      const parts = new Map<number, Uint8Array>();
      for (let i = firstChunk; i < Math.min(list.length, firstChunk + chunkCount); i++) parts.set(i, list[i]);
      return { size: list.reduce((sum, p) => sum + p.length, 0), chunks: list.length, parts };
    },
  });

  const transport: CloudBlobTransport = {
    // eslint-disable-next-line @typescript-eslint/require-await
    blobCall: async <T>(method: string, request: unknown) => {
      const r = request as { upload_id: string; index: number; data: string; chunks: number; size: string };
      if (method === 'cloud.blob.upload_chunk') {
        const id = r.upload_id || `file-${uploads.size + files.size + 1}`;
        if (!uploads.has(id)) uploads.set(id, new Map());
        uploads.get(id)!.set(r.index, unb64(r.data));
        return { uploadId: id } as T;
      }
      if (method === 'cloud.blob.upload_complete') {
        const parts = uploads.get(r.upload_id)!;
        files.set(r.upload_id, Array.from({ length: r.chunks }, (_, i) => parts.get(i)!));
        uploads.delete(r.upload_id);
        return { fileId: r.upload_id } as T;
      }
      throw new Error(method);
    },
    downloadBlobCap: (...args) => {
      directDownloads += 1;
      return session('direct').downloadBlobCap(...args);
    },
    withBlobSession: (fn) => {
      sessions += 1;
      return fn(session(`series${sessions}`));
    },
  };
  return {
    transport, log, sessions: () => sessions, directDownloads: () => directDownloads,
  };
}

function createDrive(
  server: ReturnType<typeof createServer>, limits?: { thumbCache?: number; previewCacheBytes?: number },
) {
  let revision = 1;
  const trees = new Map<string, CloudStateJson>();
  let stateJsonCalls = 0;
  const cloud = {
    revision: () => revision,
    stateJson: (id: string) => {
      stateJsonCalls += 1;
      const tree = trees.get(id);
      return tree ? JSON.stringify(tree) : undefined;
    },
  } as unknown as CloudSync;
  const drive = createCloudDrive({
    log: () => undefined,
    self: () => 'alice@test',
    cloud: () => cloud,
    transport: () => server.transport,
    mediaKeys: () => undefined,
    downloadMedia: () => Promise.resolve(undefined),
    sendFile: () => Promise.resolve(true),
    addressOf: () => undefined,
  }, limits);
  return {
    drive,
    setTree: (id: string, nodes: CloudNodeJson[]) => {
      trees.set(id, { name: id, count: nodes.length, nodes });
      revision += 1;
    },
    stateJsonCalls: () => stateJsonCalls,
  };
}

async function uploadText(server: ReturnType<typeof createServer>, id: string, text: string, key?: string) {
  const up = await uploadCloudBlob(server.transport, new Blob([text], { type: 'text/markdown' }), key ? { key } : {});
  const node: CloudNodeJson = {
    id,
    kind: 'file',
    name: `${id}.md`,
    size: up.size,
    mime: 'text/markdown',
    mtime: 1,
    trashed: false,
    trashTop: false,
    trashedAt: 0,
    blob: {
      fileId: up.fileId,
      key: up.key,
      nonce: up.nonce,
      capability: up.capability,
      size: up.size,
      chunks: up.chunks,
      mime: 'text/markdown',
      uploader: 'alice@test',
    },
  };
  return { node, up };
}

describe('провайдер облака: дерево, серии, кэши', () => {
  const urls: string[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        const url = `blob:thumb-${urls.length + 1}`;
        urls.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    urls.length = 0;
    revoked.length = 0;
  });

  it('дерево разбирается один раз на ревизию движка', async () => {
    const server = createServer();
    const { drive, setTree, stateJsonCalls } = createDrive(server);
    const a = await uploadText(server, 'a', 'раз');
    setTree('c1', [a.node]);
    expect(await drive.parvaneCloudReadText({ container: 'c1', node: 'a' })).toEqual({
      text: 'раз', fileId: a.up.fileId,
    });
    await drive.parvaneCloudReadText({ container: 'c1', node: 'a' });
    await drive.parvaneCloudReadText({ container: 'c1', node: 'нет' });
    expect(stateJsonCalls()).toBe(1);
    // Новая ревизия — новый разбор
    setTree('c1', [a.node]);
    await drive.parvaneCloudReadText({ container: 'c1', node: 'a' });
    expect(stateJsonCalls()).toBe(2);
    // Ключи из UI — без дерева вовсе
    expect(await drive.parvaneCloudReadText({ container: 'c1', node: 'a', blob: a.node.blob })).toEqual({
      text: 'раз', fileId: a.up.fileId,
    });
    expect(stateJsonCalls()).toBe(2);
  });

  it('тексты пакетом: одна серия, порядок запроса, неизвестный узел — not-found', async () => {
    const server = createServer();
    const { drive, setTree } = createDrive(server);
    const texts = ['один', 'два', 'три', 'четыре'];
    const made = await Promise.all(texts.map((t, i) => uploadText(server, `n${i}`, t)));
    setTree('c1', made.map((m) => m.node));
    const got = await drive.parvaneCloudReadTexts({
      container: 'c1',
      nodes: [{ id: 'n3' }, { id: 'нет' }, { id: 'n0', blob: made[0].node.blob }, { id: 'n1' }],
    });
    expect(got).toEqual([
      { id: 'n3', text: 'четыре', fileId: made[3].up.fileId },
      { id: 'нет', error: 'not-found' },
      { id: 'n0', text: 'один', fileId: made[0].up.fileId },
      { id: 'n1', text: 'два', fileId: made[1].up.fileId },
    ]);
    expect(server.sessions()).toBe(1);
    expect(server.directDownloads()).toBe(0);
    expect(server.log.every((line) => line.startsWith('series1 '))).toBe(true);
    // Нечего качать — серия не открывается
    expect(await drive.parvaneCloudReadTexts({ container: 'c1', nodes: [{ id: 'x' }] })).toEqual([
      { id: 'x', error: 'not-found' },
    ]);
    expect(server.sessions()).toBe(1);
  });

  it('миниатюры: общая серия на список, вытесненный адрес освобождается', async () => {
    vi.useFakeTimers();
    const server = createServer();
    const { drive, setTree } = createDrive(server, { thumbCache: 2 });
    const nodes: CloudNodeJson[] = [];
    for (let i = 0; i < 3; i++) {
      const file = await uploadText(server, `p${i}`, `картинка ${i}`);
      const thumb = await uploadCloudBlob(server.transport, new Blob([`мини ${i}`]), { key: file.up.key });
      nodes.push({
        ...file.node,
        thumb: {
          fileId: thumb.fileId, nonce: thumb.nonce, capability: thumb.capability, width: 1, height: 1,
        },
      });
    }
    setTree('c1', nodes);
    const first = await Promise.all(
      nodes.slice(0, 2).map((n) => drive.parvaneCloudThumb({ container: 'c1', node: n.id })),
    );
    expect(first).toEqual(['blob:thumb-1', 'blob:thumb-2']);
    expect(server.sessions()).toBe(1);
    // Повтор — из кэша, без скачивания
    expect(await drive.parvaneCloudThumb({ container: 'c1', node: 'p0' })).toBe('blob:thumb-1');
    expect(server.log.length).toBe(2);
    // Третья вытесняет первую: её адрес освобождён, скачана она по той же серии (пауза короче простоя)
    await vi.advanceTimersByTimeAsync(500);
    expect(await drive.parvaneCloudThumb({
      container: 'c1', node: 'p2', blob: nodes[2].blob, thumb: nodes[2].thumb,
    })).toBe('blob:thumb-3');
    expect(revoked).toEqual(['blob:thumb-1']);
    expect(server.sessions()).toBe(1);
    // Серия закрывается по простою; следующая миниатюра — новая серия
    await vi.advanceTimersByTimeAsync(5000);
    expect(await drive.parvaneCloudThumb({ container: 'c1', node: 'p0' })).toBe('blob:thumb-4');
    expect(server.sessions()).toBe(2);
  });

  it('содержимое для просмотра: кэш по байтам, старое вытесняется', async () => {
    const server = createServer();
    const { drive, setTree } = createDrive(server, { previewCacheBytes: 20 });
    const made = await Promise.all(
      ['0123456789', 'abcdefghij', 'KLMNOPQRST'].map((t, i) => uploadText(server, `f${i}`, t)),
    );
    setTree('c1', made.map((m) => m.node));
    const open = (id: string) => drive.parvaneCloudOpenBlob({ container: 'c1', node: id });
    expect(await (await open('f0'))!.text()).toBe('0123456789');
    expect(await (await open('f1'))!.text()).toBe('abcdefghij');
    expect(server.log.length).toBe(2);
    // Оба в бюджете (20 байт) — повтор из кэша
    await open('f0');
    await open('f1');
    expect(server.log.length).toBe(2);
    // Третий не влезает: самый старый (f0) вытеснен и скачается снова
    expect(await (await open('f2'))!.text()).toBe('KLMNOPQRST');
    expect(server.log.length).toBe(3);
    await open('f1');
    expect(server.log.length).toBe(3);
    await open('f0');
    expect(server.log.length).toBe(4);
  });

  it('общая серия: потребители внахлёст — одно соединение, после паузы — новое; без серии — напрямую', async () => {
    vi.useFakeTimers();
    let opened = 0;
    let closed = 0;
    const transport: CloudBlobTransport = {
      blobCall: () => Promise.reject(new Error('не нужно')),
      downloadBlobCap: () => Promise.reject(new Error('напрямую')),
      withBlobSession: async (fn) => {
        opened += 1;
        try {
          return await fn({ downloadBlobCap: () => Promise.resolve({ size: 0, chunks: 0, parts: new Map() }) });
        } finally {
          closed += 1;
        }
      },
    };
    const use = createSharedSession(() => transport, 100);
    await Promise.all([use((s) => s.downloadBlobCap('a', '', 0, 1)),
      use((s) => s.downloadBlobCap('b', '', 0, 1)),
    ]);
    expect(opened).toBe(1);
    expect(closed).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    await use(() => Promise.resolve());
    expect(opened).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(closed).toBe(1);
    await use(() => Promise.resolve());
    expect(opened).toBe(2);
    // Транспорт без серий: вызывающий получает его самого
    const plain = createSharedSession(() => ({
      blobCall: transport.blobCall, downloadBlobCap: transport.downloadBlobCap,
    }));
    await expect(plain((s) => s.downloadBlobCap('a', '', 0, 1))).rejects.toThrow('напрямую');
    // Отказ открыть серию отдаётся потребителю, следующий пробует заново
    const failing = createSharedSession(() => ({
      ...transport, withBlobSession: () => Promise.reject(new Error('нет связи')),
    }), 100);
    await expect(failing(() => Promise.resolve())).rejects.toThrow('нет связи');
    await expect(failing(() => Promise.resolve())).rejects.toThrow('нет связи');
  });
});
