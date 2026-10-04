// Протокол v2 (spec 007, T134/T162): методы управления — всё, что раньше шло
// JSON-соединением v1 и не является перепиской: вход и регистрация, профили,
// поиск, устройства, линковка, 2FA, файлы без capability (аватары, фото групп,
// блобы линковки), превью, тайлы, push, ICE. С этим слоем клиент работает при
// `PARVANE_V1_MODE=disabled` на сервере. Зеркало `parvane-core` `v2_control`.
//
// - `preauth()` — до входа: одноразовое соединение Hello → Welcome → Request
//   (gateway пускает на него только методы канала PRE и закрывает через 10 с
//   без Auth — опрос подтверждения регистрации идёт новыми вызовами);
// - `V2Control` — после входа: своё соединение Hello → Auth(JWT), открывается
//   при первом вызове и переоткрывается после обрыва. Отдельное от соединения
//   контроллера движка: работает и пока устройство ждёт линковки.
// Тела кодирует движок по имени метода; запросы и ответы — proto3-JSON.

import { loadProtocol, type Protocol } from './engine';
import { CHANNEL_IDENTIFIED, V2Connection, V2Error } from './transport';

export type V2Json = Record<string, unknown>;

const CALL_TIMEOUT_MS = 15000;
const BLOB_TIMEOUT_MS = 60000;
const UPLOAD_CHUNK_BYTES = 512 * 1024;
const DOWNLOAD_BATCH = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function openConnection(pv: Protocol, url: string): Promise<V2Connection> {
  const conn = new V2Connection(pv, url, CHANNEL_IDENTIFIED);
  const welcome = await conn.connect('v2');
  pv.verifyServerDescriptor(welcome.serverDescriptor); // бросает при негодной подписи
  return conn;
}

/** Метод канала PRE без входа (`server.describe`, `identity.session.issue`, `identity.account.*`). */
export async function preauth(url: string, method: string, request: V2Json): Promise<V2Json> {
  const pv = await loadProtocol();
  const body = pv.encodeMethodRequest(method, JSON.stringify(request));
  const conn = await openConnection(pv, url);
  try {
    return JSON.parse(pv.decodeMethodResponse(method, await conn.request(method, body, CALL_TIMEOUT_MS))) as V2Json;
  } finally {
    conn.close();
  }
}

export class V2Control {
  private opening?: Promise<V2Connection>;

  private conn?: V2Connection;

  private token?: string;

  constructor(private readonly url: () => string, private readonly getToken: () => string | undefined) {}

  /** Токен сменился (перевыпуск, другой аккаунт) — соединение открывается заново. */
  private async connection(): Promise<V2Connection> {
    const token = this.getToken();
    if (!token) throw new Error('v2 управление: нет JWT');
    if (this.conn?.isOpen && this.token === token) return this.conn;
    if (this.opening && this.token === token) return this.opening;
    this.close();
    this.token = token;
    const opening = (async () => {
      const pv = await loadProtocol();
      const conn = await openConnection(pv, this.url());
      await conn.auth(token);
      conn.onClose = () => {
        if (this.conn === conn) this.conn = undefined;
      };
      this.conn = conn;
      return conn;
    })();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  private async withConnection<T>(run: (pv: Protocol, conn: V2Connection) => Promise<T>): Promise<T> {
    const pv = await loadProtocol();
    for (let attempt = 0; ; attempt++) {
      const conn = await this.connection();
      try {
        return await run(pv, conn);
      } catch (err) {
        // Обрыв соединения — один повтор на свежем; отказ метода — наверх
        const isLost = !conn.isOpen || (err instanceof V2Error && err.code === 'ERROR_CODE_UNAVAILABLE');
        if (attempt > 0 || !isLost) throw err;
        if (this.conn === conn) this.conn = undefined;
        conn.close();
      }
    }
  }

  /** Метод реестра канала ID. Бросает `V2Error` (код протокола) либо ошибку сети. */
  call(method: string, request: V2Json, timeoutMs = CALL_TIMEOUT_MS): Promise<V2Json> {
    return this.withConnection(async (pv, conn) => {
      const body = pv.encodeMethodRequest(method, JSON.stringify(request));
      return JSON.parse(pv.decodeMethodResponse(method, await conn.request(method, body, timeoutMs))) as V2Json;
    });
  }

  /**
   * Блоб без capability: владелец — этот аккаунт. `isPublic` — открытый объект
   * (аватар, фото группы), иначе доступен только владельцу (блоб линковки).
   */
  async uploadBlob(bytes: Uint8Array, isPublic: boolean): Promise<string> {
    const total = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES));
    let uploadId = '';
    for (let index = 0; index < total; index++) {
      const data = bytes.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES);
      const got = await this.call(
        'cloud.blob.upload_chunk', { upload_id: uploadId, index, data: toBase64(data) }, BLOB_TIMEOUT_MS,
      );
      const nextId = got.uploadId || got.upload_id;
      if (typeof nextId === 'string' && nextId) uploadId = nextId;
    }
    const done = await this.call('cloud.blob.upload_complete', {
      upload_id: uploadId,
      chunks: total,
      size: String(bytes.length),
      visibility: isPublic ? 'VISIBILITY_PUBLIC' : 'VISIBILITY_PRIVATE',
    }, BLOB_TIMEOUT_MS);
    const fileId = done.fileId || done.file_id;
    if (typeof fileId !== 'string' || !fileId) throw new V2Error('ERROR_CODE_INVALID');
    return fileId;
  }

  /** Чанки блоба, доступного аккаунту (свой, открытый либо с v1-грантом), начиная с `firstChunk`. */
  downloadChunks(fileId: string, firstChunk: number, chunkCount: number) {
    return this.withConnection(async (pv, conn) => {
      const method = 'cloud.blob.download';
      const body = pv.encodeMethodRequest(method, JSON.stringify({
        file_id: fileId, first_chunk: firstChunk, chunk_count: chunkCount,
      }));
      const parts = new Map<number, Uint8Array>();
      let streamError: string | undefined;
      let finish: NoneToVoidFunction | undefined;
      const isDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const meta = JSON.parse(pv.decodeMethodResponse(method, await conn.stream(method, body, (chunk) => {
        if (chunk.error) streamError = chunk.error;
        else if (chunk.data.length) parts.set(chunk.index, chunk.data);
        if (chunk.last) finish?.();
      }, BLOB_TIMEOUT_MS))) as { size?: string | number; chunks?: number };
      // Метаданные приходят первыми; чанки — следом кадрами того же запроса
      const totalChunks = meta.chunks || 0;
      const expected = Math.min(chunkCount, Math.max(0, totalChunks - firstChunk));
      if (expected > 0 && parts.size < expected && !streamError) {
        await Promise.race([isDone, new Promise<void>((resolve) => {
          setTimeout(resolve, BLOB_TIMEOUT_MS);
        })]);
      }
      if (streamError) throw new V2Error(streamError);
      if (parts.size < expected) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      return { parts, totalChunks, size: Number(meta.size || 0) };
    });
  }

  /** Блоб целиком. */
  async downloadBlob(fileId: string): Promise<Uint8Array> {
    const pieces: Uint8Array[] = [];
    for (let first = 0; ; first += DOWNLOAD_BATCH) {
      const { parts, totalChunks } = await this.downloadChunks(fileId, first, DOWNLOAD_BATCH);
      for (let index = first; index < Math.min(totalChunks, first + DOWNLOAD_BATCH); index++) {
        const part = parts.get(index);
        if (!part) throw new V2Error('ERROR_CODE_UNAVAILABLE');
        pieces.push(part);
      }
      if (first + DOWNLOAD_BATCH >= totalChunks) break;
    }
    const out = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let offset = 0;
    pieces.forEach((piece) => {
      out.set(piece, offset);
      offset += piece.length;
    });
    return out;
  }

  async deleteBlob(fileId: string) {
    await this.call('cloud.blob.delete', { file_id: fileId });
  }

  close() {
    this.conn?.close();
    this.conn = undefined;
    this.opening = undefined;
  }
}
