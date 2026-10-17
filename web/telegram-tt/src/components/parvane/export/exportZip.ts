// Потоковая запись ZIP для «Выгрузки данных» (fflate). Файлы добавляются по одному; выход fflate
// копится короткими кусками и время от времени сворачивается в промежуточный Blob — браузер держит
// большие Blob вне кучи JS (Chromium — на диске), так что архив не лежит в памяти дважды. Тексты сжимаются,
// медиа и файлы облака кладутся как есть (они и так сжаты). ZIP64 fflate не умеет: архив и каждый файл —
// до 4 ГиБ, при превышении запись останавливается ошибкой `too-large`.

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/** Сколько байт выхода держим кусками, прежде чем свернуть их в Blob. */
const FLUSH_BYTES = 8 * 1024 * 1024;
/** Потолок ZIP без ZIP64 с запасом на заголовки и центральный каталог. */
export const ZIP_MAX_BYTES = 0xFFFFFFFF - 64 * 1024 * 1024;
const TEXT_LEVEL = 6;

export type ExportErrorCode = 'canceled' | 'too-large' | 'failed';

export class ExportError extends Error {
  code: ExportErrorCode;

  constructor(code: ExportErrorCode, message?: string) {
    super(message || code);
    this.code = code;
    this.name = 'ExportError';
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ExportError('canceled');
}

const SLICE_BYTES = 4 * 1024 * 1024;

/** Содержимое Blob кусками: потоком, где он есть, иначе срезами по 4 МиБ (так Blob тоже не читается целиком). */
async function* readChunks(blob: Blob): AsyncGenerator<Uint8Array> {
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  for (let offset = 0; offset < blob.size; offset += SLICE_BYTES) {
    yield new Uint8Array(await blob.slice(offset, offset + SLICE_BYTES).arrayBuffer());
  }
}

export type ZipWriter = {
  addText: (path: string, text: string, mtime?: Date) => Promise<void>;
  addBlob: (path: string, blob: Blob, mtime?: Date) => Promise<void>;
  /** Байт архива уже записано (сжатыми). */
  bytes: () => number;
  /** Файлов в архиве. */
  count: () => number;
  finish: () => Promise<Blob>;
  abort: () => void;
};

export function createZipWriter(options: { signal?: AbortSignal; onBytes?: (bytes: number) => void } = {}): ZipWriter {
  const { signal, onBytes } = options;
  const parts: Blob[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let written = 0;
  let files = 0;
  let failure: Error | undefined;
  let isDone = false;
  let resolveDone: (() => void) | undefined;
  const paths = new Set<string>();

  const zip = new Zip((err, chunk, final) => {
    if (err) {
      failure = err;
      return;
    }
    if (chunk.length) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      written += chunk.length;
      if (pendingBytes >= FLUSH_BYTES) flush();
      onBytes?.(written);
    }
    if (final) {
      isDone = true;
      resolveDone?.();
    }
  });

  function flush() {
    if (!pending.length) return;
    parts.push(new Blob(pending as BlobPart[]));
    pending = [];
    pendingBytes = 0;
  }

  function check(path: string, size: number) {
    throwIfAborted(signal);
    if (failure) throw new ExportError('failed', failure.message);
    if (paths.has(path)) throw new ExportError('failed', `duplicate path ${path}`);
    if (written + size > ZIP_MAX_BYTES) throw new ExportError('too-large');
    paths.add(path);
  }

  async function addBlob(path: string, blob: Blob, mtime?: Date) {
    check(path, blob.size);
    const entry = new ZipPassThrough(path);
    if (mtime) entry.mtime = mtime;
    zip.add(entry);
    files++;
    for await (const chunk of readChunks(blob)) {
      throwIfAborted(signal);
      if (chunk.length) entry.push(chunk);
      if (written > ZIP_MAX_BYTES) throw new ExportError('too-large');
    }
    entry.push(new Uint8Array(0), true);
    if (failure) throw new ExportError('failed', failure.message);
  }

  // async: ошибки проверки — отклонённым обещанием, как у `addBlob`
  // eslint-disable-next-line @typescript-eslint/require-await
  async function addText(path: string, text: string, mtime?: Date) {
    const bytes = new TextEncoder().encode(text);
    check(path, bytes.length);
    const entry = new ZipDeflate(path, { level: TEXT_LEVEL });
    if (mtime) entry.mtime = mtime;
    zip.add(entry);
    files++;
    entry.push(bytes, true);
    if (failure) throw new ExportError('failed', failure.message);
  }

  function finish() {
    throwIfAborted(signal);
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    zip.end();
    return (isDone ? Promise.resolve() : done).then(() => {
      if (failure) throw new ExportError('failed', failure.message);
      flush();
      return new Blob(parts, { type: 'application/zip' });
    });
  }

  function abort() {
    zip.terminate();
    parts.length = 0;
    pending = [];
    pendingBytes = 0;
  }

  return {
    addText,
    addBlob,
    bytes: () => written,
    count: () => files,
    finish,
    abort,
  };
}
