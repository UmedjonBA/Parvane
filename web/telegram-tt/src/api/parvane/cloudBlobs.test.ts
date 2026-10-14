import { describe, expect, it } from 'vitest';

import { V2Error } from './v2/transport';
import { decryptBlob, encryptBlobWithKey } from './blobcrypt';
import {
  CLOUD_CHUNK_BYTES, CloudAbortError, type CloudBlobTransport, cloudCipherSize, cloudPlainSize, createBlobSink,
  createCipherSource, createLimiter, downloadCloudBlob, uploadCloudBlob,
} from './cloudBlobs';

function bytesOf(length: number) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + (i >>> 8)) & 0xff;
  return out;
}

function b64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

function unb64(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

/** Мини-шард cloud: загрузки по чанкам, счёт принятых подряд, выдача окнами. */
function createServer() {
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const files = new Map<string, Uint8Array[]>();
  const calls: { method: string; index?: number }[] = [];
  let failures: V2Error[] = [];
  let onChunk: ((index: number) => void) | undefined;

  const transport: CloudBlobTransport = {
    // eslint-disable-next-line @typescript-eslint/require-await
    blobCall: async <T>(method: string, request: unknown) => {
      const r = request as {
        upload_id: string; index: number; data: string; bucket: string; chunks: number; size: string;
      };
      calls.push({ method, index: r.index });
      const failure = failures.shift();
      if (failure) throw failure;
      if (method === 'cloud.blob.upload_chunk') {
        expect(r.bucket).toBe('BLOB_BUCKET_DRIVE');
        const id = r.upload_id || `up-${uploads.size + 1}`;
        if (!uploads.has(id)) uploads.set(id, new Map());
        uploads.get(id)!.set(r.index, unb64(r.data));
        onChunk?.(r.index);
        return { uploadId: id } as T;
      }
      if (method === 'cloud.blob.upload_status') {
        const parts = uploads.get(r.upload_id);
        if (!parts) throw new V2Error('ERROR_CODE_NOT_FOUND');
        let chunks = 0;
        while (parts.has(chunks)) chunks++;
        return { chunks } as T;
      }
      if (method === 'cloud.blob.upload_complete') {
        const parts = uploads.get(r.upload_id)!;
        const list = Array.from({ length: r.chunks }, (_, i) => parts.get(i)!);
        expect(list.every(Boolean)).toBe(true);
        expect(list.reduce((sum, p) => sum + p.length, 0)).toBe(Number(r.size));
        files.set(r.upload_id, list);
        uploads.delete(r.upload_id);
        return { fileId: r.upload_id } as T;
      }
      throw new Error(method);
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    downloadBlobCap: async (fileId, _capability, firstChunk, chunkCount) => {
      calls.push({ method: 'download', index: firstChunk });
      const failure = failures.shift();
      if (failure) throw failure;
      const list = files.get(fileId)!;
      const parts = new Map<number, Uint8Array>();
      for (let i = firstChunk; i < Math.min(list.length, firstChunk + chunkCount); i++) parts.set(i, list[i]);
      return { size: list.reduce((sum, p) => sum + p.length, 0), chunks: list.length, parts };
    },
  };
  return {
    transport,
    uploads,
    files,
    calls,
    failNext: (...errors: V2Error[]) => {
      failures = errors;
    },
    watchChunks: (cb?: (index: number) => void) => {
      onChunk = cb;
    },
    cipherOf: (fileId: string) => {
      const list = files.get(fileId)!;
      const out = new Uint8Array(list.reduce((sum, p) => sum + p.length, 0));
      let cursor = 0;
      list.forEach((p) => {
        out.set(p, cursor);
        cursor += p.length;
      });
      return out;
    },
  };
}

async function download(server: ReturnType<typeof createServer>, up: Awaited<ReturnType<typeof uploadCloudBlob>>) {
  const { sink, getBlob } = createBlobSink('application/octet-stream');
  await downloadCloudBlob(server.transport, up, sink);
  return new Uint8Array(await getBlob()!.arrayBuffer());
}

describe('блобы облака: потоковый PVB2', () => {
  it('размеры шифртекста и открытого текста обратимы', () => {
    [0, 1, 262143, 262144, 262145, 5 * 262144 + 7].forEach((size) => {
      expect(cloudPlainSize(cloudCipherSize(size))).toBe(size);
    });
  });

  it('отрезки шифртекста совпадают с шифрованием целиком', async () => {
    const key = bytesOf(32);
    const nonce = bytesOf(12);
    for (const size of [0, 1, 1000, 262144, 262145, 3 * 262144 + 100]) {
      const plain = bytesOf(size);
      const whole = await encryptBlobWithKey(plain, key, nonce);
      const source = createCipherSource(new Blob([plain]), key, nonce);
      expect(source.cipherSize).toBe(whole.length);
      // Произвольные отрезки, в том числе через границы кусков и заголовка
      const ranges = [[0, whole.length], [0, 5], [3, 20], [262100, 262300], [whole.length - 9, whole.length]];
      for (const [from, to] of ranges) {
        if (from < 0 || from > whole.length) continue;
        expect(Array.from(await source.range(from, to))).toEqual(Array.from(whole.subarray(from, to)));
      }
    }
  });

  it('загрузка окном и скачивание окнами возвращают исходные байты', async () => {
    const server = createServer();
    // 37 чанков облака: скачивание идёт двумя окнами по 32
    const plain = bytesOf(37 * CLOUD_CHUNK_BYTES - 5000);
    const progress: number[] = [];
    const up = await uploadCloudBlob(server.transport, new Blob([plain]), {
      onProgress: (sent, total) => progress.push(sent / total),
    });
    expect(up.size).toBe(plain.length);
    expect(up.chunks).toBe(Math.ceil(cloudCipherSize(plain.length) / CLOUD_CHUNK_BYTES));
    expect(progress.at(-1)).toBe(1);
    // На сервере лежит обычный PVB2: его открывает прежняя расшифровка целиком
    const opened = await decryptBlob(server.cipherOf(up.fileId), up.key, up.nonce);
    expect(opened && Buffer.compare(Buffer.from(opened), Buffer.from(plain))).toBe(0);
    const got = await download(server, up);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
    expect(server.calls.filter((c) => c.method === 'download').map((c) => c.index)).toEqual([0, 32]);
  }, 60000);

  it('чанки уходят двоичным телом в bucket «Облака», без base64 в JSON', async () => {
    const server = createServer();
    const binary: { index: number; bucket?: number }[] = [];
    const json = server.transport.blobCall;
    server.transport.uploadBlobChunk = (uploadId, index, data, bucket) => {
      binary.push({ index, bucket });
      // Тот же мини-шард, но байты приходят как есть
      return json<{ uploadId: string }>('cloud.blob.upload_chunk', {
        upload_id: uploadId, index, data: b64(data), bucket: bucket === 1 ? 'BLOB_BUCKET_DRIVE' : 'other',
      }).then((got) => got.uploadId);
    };
    server.transport.blobCall = <T>(method: string, request: unknown) => {
      expect(method).not.toBe('cloud.blob.upload_chunk');
      return json<T>(method, request);
    };
    const plain = bytesOf(3 * CLOUD_CHUNK_BYTES);
    const up = await uploadCloudBlob(server.transport, new Blob([plain]));
    expect(binary.map((c) => c.index).sort((a, b) => a - b)).toEqual(Array.from({ length: up.chunks }, (_, i) => i));
    expect(binary.every((c) => c.bucket === 1)).toBe(true);
    const got = await download(server, up);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
  });

  it('следующее окно запрашивается, пока предыдущее пишется в приёмник', async () => {
    const server = createServer();
    // Три окна: 70 чанков облака
    const plain = bytesOf(70 * CLOUD_CHUNK_BYTES - 777);
    const up = await uploadCloudBlob(server.transport, new Blob([plain]));
    const order: string[] = [];
    const transport = {
      ...server.transport,
      downloadBlobCap: (fileId: string, capability: string, first: number, count: number) => {
        order.push(`request ${first}`);
        return server.transport.downloadBlobCap(fileId, capability, first, count);
      },
    };
    const { sink, getBlob } = createBlobSink('application/octet-stream');
    let writes = 0;
    await downloadCloudBlob(transport, up, {
      ...sink,
      write: async (bytes) => {
        writes += 1;
        order.push(`write ${writes}`);
        // Медленный приёмник: за это время уже должен уйти запрос следующего окна
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        return sink.write(bytes);
      },
    });
    expect(Buffer.compare(Buffer.from(new Uint8Array(await getBlob()!.arrayBuffer())), Buffer.from(plain))).toBe(0);
    expect(order).toEqual(['request 0', 'request 32', 'write 1', 'request 64', 'write 2', 'write 3']);
  }, 60000);

  it('ограничитель: не больше N задач разом, остальные ждут своей очереди', async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      active -= 1;
      return i;
    })));
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
    // Ошибка задачи освобождает место
    await expect(run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await run(() => Promise.resolve('ok'))).toBe('ok');
  });

  it('пустой файл и файл в один байт', async () => {
    const server = createServer();
    for (const size of [0, 1]) {
      const up = await uploadCloudBlob(server.transport, new Blob([bytesOf(size)]));
      expect(up.chunks).toBe(1);
      expect((await download(server, up)).length).toBe(size);
    }
  });

  it('ограничение частоты и недоступность — повтор того же чанка', async () => {
    const server = createServer();
    const plain = bytesOf(3 * CLOUD_CHUNK_BYTES);
    server.failNext(new V2Error('ERROR_CODE_RATE_LIMITED', 5), new V2Error('ERROR_CODE_UNAVAILABLE'));
    const up = await uploadCloudBlob(server.transport, new Blob([plain]));
    expect(server.calls.filter((c) => c.method === 'cloud.blob.upload_chunk' && c.index === 0).length).toBe(3);
    expect(Buffer.compare(Buffer.from(await download(server, up)), Buffer.from(plain))).toBe(0);
    // Отказ не из повторяемых — наружу
    server.failNext(new V2Error('ERROR_CODE_LIMIT'));
    await expect(uploadCloudBlob(server.transport, new Blob([plain])))
      .rejects.toMatchObject({ code: 'ERROR_CODE_LIMIT' });
  }, 30000);

  it('отмена останавливает загрузку, продолжение досылает остаток с теми же ключами', async () => {
    const server = createServer();
    const plain = bytesOf(9 * CLOUD_CHUNK_BYTES);
    const abort = new AbortController();
    let started: Parameters<NonNullable<Parameters<typeof uploadCloudBlob>[2]>['onStarted'] & {}>[0] | undefined;
    server.watchChunks((index) => {
      if (index >= 4) abort.abort();
    });
    await expect(uploadCloudBlob(server.transport, new Blob([plain]), {
      signal: abort.signal,
      onStarted: (state) => {
        started = state;
      },
    })).rejects.toBeInstanceOf(CloudAbortError);
    server.watchChunks();
    expect(server.files.size).toBe(0);
    const before = server.calls.length;
    const up = await uploadCloudBlob(server.transport, new Blob([plain]), { resume: started });
    expect(up.fileId).toBe(started!.uploadId);
    expect((up.key === started!.key) && (up.nonce === started!.nonce)).toBe(true);
    // Уже принятые подряд чанки заново не шлются
    const resent = server.calls.slice(before)
      .filter((c) => c.method === 'cloud.blob.upload_chunk').map((c) => c.index!);
    expect(Math.min(...resent)).toBeGreaterThanOrEqual(4);
    expect(Buffer.compare(Buffer.from(await download(server, up)), Buffer.from(plain))).toBe(0);
    // Загрузку на сервере убрали — продолжение начинает заново
    const fresh = await uploadCloudBlob(server.transport, new Blob([plain]), {
      resume: { ...started!, uploadId: 'gone' },
    });
    expect(fresh.fileId).not.toBe('gone');
  }, 60000);

  it('подмена шифртекста и чужой ключ обрывают скачивание, приёмник сбрасывается', async () => {
    const server = createServer();
    const plain = bytesOf(2 * CLOUD_CHUNK_BYTES);
    const up = await uploadCloudBlob(server.transport, new Blob([plain]));
    await expect(download(server, { ...up, key: b64(bytesOf(32)) }))
      .rejects.toMatchObject({ code: 'ERROR_CODE_INVALID' });
    server.files.get(up.fileId)![1][100] ^= 1;
    let isAborted = false;
    const { sink } = createBlobSink('x');
    await expect(downloadCloudBlob(server.transport, up, {
      ...sink,
      abort: () => {
        isAborted = true;
        return Promise.resolve();
      },
    })).rejects.toMatchObject({ code: 'ERROR_CODE_INVALID' });
    expect(isAborted).toBe(true);
    // Заявленный размер больше настоящего — отказ, а не усечённый файл
    server.files.get(up.fileId)![1][100] ^= 1;
    await expect(download(server, { ...up, size: up.size + 1 })).rejects.toBeDefined();
  }, 30000);
});
