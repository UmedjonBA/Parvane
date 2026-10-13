import { V2Error } from './v2/transport';
import {
  BLOB_DEFAULT_CHUNK, BLOB_HEADER_BYTES, BLOB_TAG_BYTES, decryptBlobChunks, sealBlobChunk, writeBlobHeader,
} from './blobcrypt';

// Parvane (spec 016): блобы раздела «Облако». Файл до 2 ГБ нельзя держать в
// памяти целиком, поэтому и загрузка, и скачивание идут потоком:
//   - шифртекст PVB2 (BLOB-1) детерминирован ключом и nonce, поэтому любой его
//     отрезок вычисляется из нужных кусков файла (`File.slice`) — чанк облака
//     можно собрать заново для повтора и продолжения после обрыва;
//   - чанки облака одного размера (512 КиБ), уходят окном из нескольких
//     параллельных запросов; первый чанк заводит загрузку;
//   - скачивание — окнами чанков облака, каждый кусок PVB2 проверяется тегом и
//     сразу уходит в приёмник (файл на диске либо части Blob); следующее окно
//     запрашивается заранее, пока текущее расшифровывается и пишется.

/** Размер чанка облака, байт шифртекста. */
export const CLOUD_CHUNK_BYTES = 512 * 1024;
const UPLOAD_WINDOW = 3;
const DOWNLOAD_WINDOW_CHUNKS = 32;
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 700;
const RETRY_MAX_MS = 15000;
const KEY_LEN = 32;
const NONCE_LEN = 12;
const CAPABILITY_LEN = 32;
const SEALED_CACHE = 4;

export type CloudBlobKeys = {
  /** Ключ, nonce и секрет доступа — base64. */
  key: string;
  nonce: string;
  capability: string;
};

export type CloudUploadResult = CloudBlobKeys & {
  fileId: string;
  /** Размер открытого файла. */
  size: number;
  /** Число чанков облака. */
  chunks: number;
};

/** Серия скачиваний по одному анонимному соединению (A9). */
export type BlobSession = {
  downloadBlobCap: (fileId: string, capabilityB64: string, firstChunk: number, chunkCount: number) => Promise<{
    size: number; chunks: number; parts: Map<number, Uint8Array>;
  }>;
};

export type CloudBlobTransport = BlobSession & {
  /** Метод блобов шарда cloud по имени: proto3-JSON запроса → proto3-JSON ответа. */
  blobCall: <T>(method: string, request: unknown) => Promise<T>;
  /** Серия: все `session.downloadBlobCap` внутри `fn` — по одному соединению
   * (миниатюры папки, тексты заметок); без серии — соединение на каждый блоб. */
  withBlobSession?: <T>(fn: (session: BlobSession) => Promise<T>) => Promise<T>;
};

export type CloudUploadOptions = {
  /** Продолжить загрузку с теми же ключами (после обрыва). */
  resume?: CloudBlobKeys & { uploadId: string };
  /** Ключ другого блоба (миниатюра шифруется ключом файла). */
  key?: string;
  signal?: AbortSignal;
  /** Загрузка заведена на сервере: её можно будет продолжить. */
  onStarted?: (state: CloudBlobKeys & { uploadId: string }) => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
};

export type CloudSink = {
  write: (bytes: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};

export class CloudAbortError extends Error {
  constructor() {
    super('cloud: aborted');
  }
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function fromBase64(data: string) {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CloudAbortError());
    }, { once: true });
  });
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new CloudAbortError();
}

function isRetryable(e: unknown) {
  if (!(e instanceof V2Error)) return !(e instanceof CloudAbortError);
  return e.code === 'ERROR_CODE_UNAVAILABLE' || e.code === 'ERROR_CODE_RATE_LIMITED';
}

/** Повторять запрос при недоступности и ограничении частоты (ждать `retry_after`). */
export async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    checkAborted(signal);
    try {
      return await fn();
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(e)) throw e;
      const hinted = e instanceof V2Error ? e.retryAfterMs : 0;
      await pause(Math.max(hinted, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1))), signal);
    }
  }
}

/** Очередь с пределом одновременных задач (миниатюры, картинки холста). */
export function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  function next() {
    active -= 1;
    waiting.shift()?.();
  }
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    active += 1;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

/** Длина шифртекста PVB2 для открытого файла `size` байт. */
export function cloudCipherSize(size: number, chunkSize = BLOB_DEFAULT_CHUNK) {
  const total = size === 0 ? 1 : Math.ceil(size / chunkSize);
  return BLOB_HEADER_BYTES + size + total * BLOB_TAG_BYTES;
}

/** Открытый размер по длине шифртекста (обратное к `cloudCipherSize`). */
export function cloudPlainSize(cipherSize: number, chunkSize = BLOB_DEFAULT_CHUNK) {
  const body = Math.max(0, cipherSize - BLOB_HEADER_BYTES);
  const total = Math.max(1, Math.ceil(body / (chunkSize + BLOB_TAG_BYTES)));
  return Math.max(0, body - total * BLOB_TAG_BYTES);
}

/**
 * Отрезки шифртекста PVB2 файла по требованию: куски шифруются из `File.slice`,
 * последние запечатанные куски кэшируются (чанк облака захватывает соседние).
 */
export function createCipherSource(file: Blob, rawKey: Uint8Array, nonce: Uint8Array, chunkSize = BLOB_DEFAULT_CHUNK) {
  const total = file.size === 0 ? 1 : Math.ceil(file.size / chunkSize);
  const sealedSize = chunkSize + BLOB_TAG_BYTES;
  const cipherSize = cloudCipherSize(file.size, chunkSize);
  const cache = new Map<number, Promise<Uint8Array>>();

  function sealed(index: number) {
    let hit = cache.get(index);
    if (!hit) {
      hit = file.slice(index * chunkSize, (index + 1) * chunkSize).arrayBuffer()
        .then((buffer) => sealBlobChunk(new Uint8Array(buffer), rawKey, nonce, chunkSize, index, total));
      cache.set(index, hit);
      if (cache.size > SEALED_CACHE) cache.delete(cache.keys().next().value!);
    }
    return hit;
  }

  /** Байты шифртекста [from, to). */
  async function range(from: number, to: number): Promise<Uint8Array> {
    const end = Math.min(to, cipherSize);
    const out = new Uint8Array(Math.max(0, end - from));
    let cursor = from;
    if (cursor < BLOB_HEADER_BYTES) {
      const header = writeBlobHeader(chunkSize).subarray(cursor, Math.min(end, BLOB_HEADER_BYTES));
      out.set(header, 0);
      cursor += header.length;
    }
    while (cursor < end) {
      const index = Math.floor((cursor - BLOB_HEADER_BYTES) / sealedSize);
      const start = BLOB_HEADER_BYTES + index * sealedSize;
      const part = (await sealed(index)).subarray(cursor - start, end - start);
      out.set(part, cursor - from);
      cursor += part.length;
    }
    return out;
  }

  return { cipherSize, range };
}

/** Загрузить файл в облако (bucket DRIVE) потоком. */
export async function uploadCloudBlob(
  transport: CloudBlobTransport, file: Blob, options: CloudUploadOptions = {},
): Promise<CloudUploadResult> {
  const { resume, signal } = options;
  const rawKey = fromBase64(resume?.key || options.key || toBase64(crypto.getRandomValues(new Uint8Array(KEY_LEN))));
  const nonce = resume ? fromBase64(resume.nonce) : crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const capability = resume
    ? fromBase64(resume.capability)
    : crypto.getRandomValues(new Uint8Array(CAPABILITY_LEN));
  const keys: CloudBlobKeys = {
    key: toBase64(rawKey), nonce: toBase64(nonce), capability: toBase64(capability),
  };
  const source = createCipherSource(file, rawKey, nonce);
  const chunks = Math.max(1, Math.ceil(source.cipherSize / CLOUD_CHUNK_BYTES));
  let sent = 0;

  async function sendChunk(uploadId: string, index: number) {
    const data = await source.range(index * CLOUD_CHUNK_BYTES, (index + 1) * CLOUD_CHUNK_BYTES);
    const got = await withRetry(() => transport.blobCall<{ uploadId?: string; upload_id?: string }>(
      'cloud.blob.upload_chunk',
      {
        upload_id: uploadId, index, data: toBase64(data), bucket: 'BLOB_BUCKET_DRIVE',
      },
    ), signal);
    sent += data.length;
    options.onProgress?.(Math.min(sent, source.cipherSize), source.cipherSize);
    return got.uploadId || got.upload_id || uploadId;
  }

  let uploadId = resume?.uploadId || '';
  let next = 0;
  if (uploadId) {
    // Продолжение: сервер говорит, сколько чанков принято подряд; загрузку
    // могли уже убрать (сутки без активности) — тогда начинаем заново
    try {
      const status = await withRetry(() => transport.blobCall<{ chunks?: number }>(
        'cloud.blob.upload_status', { upload_id: uploadId },
      ), signal);
      next = Math.min(chunks, status.chunks || 0);
      sent = Math.min(source.cipherSize, next * CLOUD_CHUNK_BYTES);
    } catch (e) {
      if (!(e instanceof V2Error) || e.code !== 'ERROR_CODE_NOT_FOUND') throw e;
      uploadId = '';
    }
  }
  if (!uploadId) {
    uploadId = await sendChunk('', 0);
    next = 1;
  }
  options.onStarted?.({ ...keys, uploadId });

  // Окно параллельных запросов: порядок чанков на сервере не важен
  let failure: unknown;
  async function worker() {
    while (next < chunks && !failure) {
      const index = next++;
      try {
        await sendChunk(uploadId, index);
      } catch (e) {
        failure = failure || e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_WINDOW, Math.max(0, chunks - next)) }, worker));
  if (failure) throw failure instanceof Error ? failure : new V2Error('ERROR_CODE_UNAVAILABLE');
  checkAborted(signal);

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', capability));
  const done = await withRetry(() => transport.blobCall<{ fileId?: string; file_id?: string }>(
    'cloud.blob.upload_complete',
    {
      upload_id: uploadId,
      chunks,
      size: String(source.cipherSize),
      visibility: 'VISIBILITY_PRIVATE',
      capability_hash: toBase64(hash),
    },
  ), signal);
  const fileId = done.fileId || done.file_id;
  if (!fileId) throw new V2Error('ERROR_CODE_INVALID');
  return {
    ...keys, fileId, size: file.size, chunks,
  };
}

/**
 * Скачать блоб облака в приёмник: окна чанков облака, каждый кусок PVB2
 * проверяется тегом. `size` — открытый размер файла (из узла дерева).
 * `transport` может быть сессией серии (`BlobSession`): тогда все окна идут по
 * её соединению.
 */
export async function downloadCloudBlob(
  transport: BlobSession,
  blob: CloudBlobKeys & { fileId: string; size: number; chunks: number },
  sink: CloudSink,
  options: { signal?: AbortSignal; onProgress?: (doneBytes: number, totalBytes: number) => void } = {},
): Promise<void> {
  const { signal } = options;
  const chunkSize = BLOB_DEFAULT_CHUNK;
  const sealedSize = chunkSize + BLOB_TAG_BYTES;
  const totalSealed = blob.size === 0 ? 1 : Math.ceil(blob.size / chunkSize);
  const header = { chunkSize };
  let carry = new Uint8Array(0);
  let nextSealed = 0;
  let isHeaderRead = false;
  let written = 0;
  const fetchWindow = (first: number) => {
    const count = Math.min(DOWNLOAD_WINDOW_CHUNKS, blob.chunks - first);
    const window = withRetry(() => transport.downloadBlobCap(blob.fileId, blob.capability, first, count), signal);
    // Предзапрошенное окно может отвергнуться уже после того, как цикл прервался своей ошибкой
    window.catch(() => undefined);
    return window;
  };
  try {
    // Одно окно «в полёте» заранее: сеть не ждёт расшифровки и записи предыдущего
    let pending = fetchWindow(0);
    for (let first = 0; first < blob.chunks; first += DOWNLOAD_WINDOW_CHUNKS) {
      checkAborted(signal);
      const count = Math.min(DOWNLOAD_WINDOW_CHUNKS, blob.chunks - first);
      const got = await pending;
      if (first + count < blob.chunks) pending = fetchWindow(first + count);
      const parts: Uint8Array[] = [carry];
      for (let index = first; index < first + count; index++) {
        const part = got.parts.get(index);
        if (!part) throw new V2Error('ERROR_CODE_UNAVAILABLE');
        parts.push(part);
      }
      let buffer = concat(parts);
      if (!isHeaderRead) {
        if (buffer.length < BLOB_HEADER_BYTES) throw new V2Error('ERROR_CODE_INVALID');
        const declared = new DataView(buffer.buffer, buffer.byteOffset).getUint32(4, false);
        if (declared !== chunkSize) throw new V2Error('ERROR_CODE_INVALID');
        buffer = buffer.subarray(BLOB_HEADER_BYTES);
        isHeaderRead = true;
      }
      // Расшифровываем только целые куски; последний кусок файла короче
      const isLastWindow = first + count >= blob.chunks;
      const ready = isLastWindow ? buffer.length : Math.floor(buffer.length / sealedSize) * sealedSize;
      if (ready > 0) {
        const plain = await decryptBlobChunks(
          buffer.subarray(0, ready), blob.key, blob.nonce, header, nextSealed, totalSealed,
        );
        if (!plain) throw new V2Error('ERROR_CODE_INVALID');
        nextSealed += Math.ceil(ready / sealedSize);
        await sink.write(plain);
        written += plain.length;
        options.onProgress?.(written, blob.size);
      }
      carry = buffer.slice(ready);
    }
    if (nextSealed !== totalSealed || written !== blob.size) throw new V2Error('ERROR_CODE_INVALID');
    await sink.close();
  } catch (e) {
    await sink.abort().catch(() => undefined);
    throw e;
  }
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Приёмник в память: части Blob (просмотр, файлы до предела буфера). */
export function createBlobSink(mimeType: string) {
  const parts: BlobPart[] = [];
  let result: Blob | undefined;
  const sink: CloudSink = {
    write: (bytes) => {
      parts.push(bytes as BlobPart);
      return Promise.resolve();
    },
    close: () => {
      result = new Blob(parts, { type: mimeType });
      return Promise.resolve();
    },
    abort: () => {
      parts.length = 0;
      return Promise.resolve();
    },
  };
  return { sink, getBlob: () => result };
}

/** Приёмник в файл на диске (File System Access API). */
export async function createFileSink(handle: FileSystemFileHandle): Promise<CloudSink> {
  const writable = await handle.createWritable();
  return {
    write: (bytes) => writable.write(bytes as BufferSource),
    close: () => writable.close(),
    abort: () => writable.abort(),
  };
}
