import type { SendMessageParams } from '../../types';
import type { ApiMessage } from '../types';
import type { GatewayConnection } from './gateway';
import type { ParvaneStore } from './store';

import { diagLog } from '../../util/parvaneDiag';
import { decryptBlob, decryptRange, encryptBlob } from './blobcrypt';
import { getActiveGroupMemberAddresses } from './e2eSendPolicy';
import { apiEntitiesToWire } from './entities';
import {
  buildWireEvent,
  TOPIC_FILE_DOWNLOAD_REQUEST,
  TOPIC_FILE_UPLOAD_CHUNK,
  TOPIC_FILE_UPLOAD_COMPLETE,
  TOPIC_PREVIEW_FETCH,
  TOPIC_PREVIEW_MAP_TILE,
  type WireMessageContent,
} from './wire';

type MediaDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
};

type CloudUploadOptions = {
  encrypt?: boolean;
  recipients?: string[];
  publicAccess?: boolean;
};

type WireDownloadChunk = {
  ok: boolean;
  chunk_index?: number;
  total_chunks?: number;
  data?: string;
  mime_type?: string;
  error?: string;
  size_bytes?: number;
  chunk_bytes?: number;
};

type CachedMedia = { blob: Blob; mimeType: string } | undefined;

const UPLOAD_CHUNK_BYTES = 192 * 1024;
const MEDIA_TIMEOUT_MS = 30000;
const MEDIA_URL_REGEX = /^(?:photo|document)([\w-]+?)(?:\?|$)/;
const PROGRESSIVE_MEDIA_FORMAT = 1; // ApiMediaFormat.Progressive
// Статичная карта геолокации: tt просит `staticMap:<hash>?lat&long&w&h&zoom&scale`
// (Telegram отдаёт картинку со своего сервера). Мы склеиваем OSM-тайлы,
// полученные через шард preview (наружу ходит сервер, а не браузер)
const MAP_TILE_SIZE = 256;
// Range-стриминг: кэш шифртекст-чанков на файл (сколько держим в памяти)
const RANGE_CHUNK_CACHE_LIMIT = 96;
const GCM_TAG_BYTES = 16;
// Лимиты на серверные метаданные (size_bytes/chunk_bytes/данные чанка): без
// них подделанный ответ cloud заставлял бы вкладку выделить произвольный объём
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_RANGE_WINDOW_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BASE64_LENGTH = Math.ceil(MAX_CHUNK_BYTES / 3) * 4 + 4;
// Бюджеты кэшей: раньше все скачанные блобы, тайлы карт и чанки видео жили
// в памяти до logout (1 ГБ просмотренного медиа = 1 ГБ resident)
const BLOB_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;
const TILE_CACHE_LIMIT = 200;
const RANGE_FILE_CACHE_LIMIT = 6;
// 1×1 прозрачный PNG — заглушка миниатюр видео
const TRANSPARENT_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
  + 'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MAP_TILE_TIMEOUT_MS = 15000;
const MAP_TILE_RETRY_MS = 1500;
const URL_REGEX = /https?:\/\/[^\s]+/;

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function decodeBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

export function createMediaService(deps: MediaDependencies) {
  const cacheByFileId = new Map<string, Promise<CachedMedia>>();
  // Ключи и настоящий mime приходят внутри E2E content; cloud видит только
  // нейтральный application/octet-stream.
  const keysByFileId = new Map<string, { keyB64: string; nonceB64: string }>();
  const mimeByFileId = new Map<string, string>();

  function requireConnection() {
    const connection = deps.getConnection();
    if (!connection) throw new Error('Gateway: соединение не открыто');
    return connection;
  }

  function getCloudRecipients(toAddress: string) {
    const store = deps.getStore();
    const groupInfo = store.getGroupInfo(toAddress);
    if (!groupInfo) return toAddress === store.self ? [] : [toAddress];
    return getActiveGroupMemberAddresses(groupInfo.members)
      .filter((address) => address !== store.self);
  }

  async function uploadBlob(
    blob: Blob,
    filename: string,
    mimeType: string,
    options: CloudUploadOptions = {},
  ) {
    const { encrypt = false, recipients = [], publicAccess = false } = options;
    const store = deps.getStore();
    const connection = requireConnection();
    const fileId = crypto.randomUUID();
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
    let mediaKeys: { keyB64: string; nonceB64: string } | undefined;
    if (encrypt) {
      const encrypted = await encryptBlob(bytes);
      bytes = encrypted.ciphertext;
      mediaKeys = { keyB64: encrypted.keyB64, nonceB64: encrypted.nonceB64 };
    }
    const cloudMime = encrypt ? 'application/octet-stream' : mimeType;
    const totalChunks = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES));
    for (let index = 0; index < totalChunks; index++) {
      const slice = bytes.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES);
      const chunkEvent = buildWireEvent(store.self, deps.getToken(), {
        file_id: fileId,
        chunk_index: index,
        total_chunks: totalChunks,
        data: encodeBase64(slice),
        filename,
        mime_type: cloudMime,
      });
      await connection.request(TOPIC_FILE_UPLOAD_CHUNK, JSON.stringify(chunkEvent), MEDIA_TIMEOUT_MS);
    }
    const completeEvent = buildWireEvent(store.self, deps.getToken(), {
      file_id: fileId,
      filename,
      total_chunks: totalChunks,
      size_bytes: bytes.length,
      mime_type: cloudMime,
      recipients,
      public_access: publicAccess,
    });
    const raw = await connection.request(
      TOPIC_FILE_UPLOAD_COMPLETE,
      JSON.stringify(completeEvent),
      MEDIA_TIMEOUT_MS,
    );
    const response = JSON.parse(raw) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error || 'upload.complete отказ');
    if (mediaKeys) {
      keysByFileId.set(fileId, mediaKeys);
      cacheByFileId.set(fileId, Promise.resolve({ blob, mimeType }));
    }
    return { fileId, size: blob.size, mediaKeys };
  }

  // ── range-стриминг (прогрессивное видео) ─────────────────────────────────
  // Service worker просит байты [start,end]; качаем только нужные чанки
  // (chunk_from/chunk_to), дешифруем окно AES-CTR по смещению GCM-потока.
  // Метаданные (размер, размер чанка) приходят с любым чанком — берём с
  // первого запроса
  type FileMeta = { sizeBytes: number; chunkBytes: number; totalChunks: number; mimeType: string };
  const metaByFileId = new Map<string, FileMeta>();
  const chunkCacheByFileId = new Map<string, Map<number, Uint8Array>>();

  function rememberChunk(fileId: string, index: number, bytes: Uint8Array) {
    let cache = chunkCacheByFileId.get(fileId);
    if (!cache) {
      cache = new Map();
      if (chunkCacheByFileId.size >= RANGE_FILE_CACHE_LIMIT) {
        const oldest = chunkCacheByFileId.keys().next().value;
        if (oldest !== undefined) chunkCacheByFileId.delete(oldest);
      }
      chunkCacheByFileId.set(fileId, cache);
    }
    cache.set(index, bytes);
    if (cache.size > RANGE_CHUNK_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  async function fetchChunkRange(fileId: string, from: number, to: number) {
    const store = deps.getStore();
    const event = buildWireEvent(store.self, deps.getToken(), { file_id: fileId, chunk_from: from, chunk_to: to });
    const expected = to - from + 1;
    const replies = await requireConnection().requestMany(
      TOPIC_FILE_DOWNLOAD_REQUEST, JSON.stringify(event), undefined, undefined,
      (collected) => collected.length >= expected,
    );
    const chunks = replies
      .map((reply) => JSON.parse(reply) as WireDownloadChunk)
      .filter((chunk) => chunk.ok && chunk.data !== undefined && chunk.chunk_index !== undefined);
    chunks.forEach((chunk) => {
      if (!metaByFileId.has(fileId) && chunk.size_bytes && chunk.chunk_bytes && chunk.total_chunks
        && chunk.size_bytes <= MAX_FILE_BYTES && chunk.chunk_bytes <= MAX_CHUNK_BYTES) {
        metaByFileId.set(fileId, {
          sizeBytes: chunk.size_bytes,
          chunkBytes: chunk.chunk_bytes,
          totalChunks: chunk.total_chunks,
          // MIME — ТОЛЬКО из E2E-обёртки сообщения, не из ответа cloud: иначе
          // сервер мог бы отдать окно видео как text/html на same-origin URL
          mimeType: mimeByFileId.get(fileId) || 'application/octet-stream',
        });
      }
      if (chunk.data!.length > MAX_CHUNK_BASE64_LENGTH) return;
      rememberChunk(fileId, chunk.chunk_index!, decodeBase64(chunk.data!));
    });
    return chunks.length > 0;
  }

  async function verifyCompleteFile(
    fileId: string, meta: FileMeta, keys: { keyB64: string; nonceB64: string },
  ): Promise<Blob | 'bad' | undefined> {
    const cached = chunkCacheByFileId.get(fileId);
    if (!cached) return undefined;
    const parts: Uint8Array[] = [];
    for (let index = 0; index < meta.totalChunks; index++) {
      const bytes = cached.get(index);
      if (!bytes) return undefined;
      parts.push(bytes);
    }
    const plain = await decryptBlob(concatBytes(parts), keys.keyB64, keys.nonceB64);
    chunkCacheByFileId.delete(fileId);
    if (!plain) {
      diagLog('media', `файл ${fileId}: GCM-тег не сошёлся — стрим отброшен`);
      metaByFileId.delete(fileId);
      return 'bad';
    }
    const blob = new Blob([plain as BlobPart], { type: meta.mimeType });
    cacheByFileId.set(fileId, Promise.resolve({ blob, mimeType: meta.mimeType }));
    return blob;
  }

  async function downloadRange(fileId: string, start: number, end: number | undefined) {
    const keys = keysByFileId.get(fileId);
    if (!keys) return undefined;
    if (!metaByFileId.has(fileId)) await fetchChunkRange(fileId, 0, 0);
    const meta = metaByFileId.get(fileId);
    if (!meta || !meta.chunkBytes) return undefined;
    const fullSize = meta.sizeBytes - GCM_TAG_BYTES;
    if (fullSize <= 0 || start >= fullSize) return undefined;
    const lastByte = Math.min(end ?? fullSize - 1, fullSize - 1, start + MAX_RANGE_WINDOW_BYTES - 1);
    const alignedStart = Math.floor(start / 16) * 16;
    const chunkFrom = Math.floor(alignedStart / meta.chunkBytes);
    const chunkTo = Math.floor(lastByte / meta.chunkBytes);
    const cache = chunkCacheByFileId.get(fileId) || new Map<number, Uint8Array>();
    let missingFrom: number | undefined;
    for (let index = chunkFrom; index <= chunkTo; index++) {
      if (!cache.has(index)) {
        missingFrom = index;
        break;
      }
    }
    if (missingFrom !== undefined) {
      const fetched = await fetchChunkRange(fileId, missingFrom, chunkTo);
      if (!fetched) return undefined;
    }
    const cached = chunkCacheByFileId.get(fileId)!;
    // Все чанки на руках — проверяем GCM-тег целого файла (окна идут без
    // аутентификации) и дальше отдаём из проверенного блоба
    if (cached.size >= meta.totalChunks) {
      const verified = await verifyCompleteFile(fileId, meta, keys);
      if (verified === 'bad') return undefined;
      if (verified) {
        const buffer = await verified.arrayBuffer();
        return { arrayBuffer: buffer.slice(start, lastByte + 1), mimeType: meta.mimeType, fullSize };
      }
    }
    const window = new Uint8Array(lastByte - alignedStart + 1);
    for (let index = chunkFrom; index <= chunkTo; index++) {
      const bytes = cached.get(index);
      if (!bytes) return undefined;
      const chunkStart = index * meta.chunkBytes;
      const copyFrom = Math.max(alignedStart, chunkStart);
      const copyTo = Math.min(lastByte, chunkStart + bytes.length - 1);
      if (copyTo < copyFrom) continue;
      window.set(bytes.subarray(copyFrom - chunkStart, copyTo - chunkStart + 1), copyFrom - alignedStart);
    }
    const plain = await decryptRange(window, keys.keyB64, keys.nonceB64, alignedStart);
    if (!plain) return undefined;
    const slice = plain.slice(start - alignedStart);
    return { arrayBuffer: slice.buffer, mimeType: meta.mimeType, fullSize };
  }

  async function downloadBlob(fileId: string): Promise<CachedMedia> {
    const store = deps.getStore();
    const event = buildWireEvent(store.self, deps.getToken(), { file_id: fileId });
    // Число чанков известно из первого ответа — завершаем без паузы тишины
    const replies = await requireConnection().requestMany(
      TOPIC_FILE_DOWNLOAD_REQUEST,
      JSON.stringify(event),
      undefined,
      undefined,
      (collected) => {
        const total = (JSON.parse(collected[0]) as WireDownloadChunk).total_chunks;
        return Boolean(total) && collected.length >= total;
      },
    );
    const chunks = replies
      .map((reply) => JSON.parse(reply) as WireDownloadChunk)
      .filter((chunk) => chunk.ok && chunk.data !== undefined && chunk.chunk_index !== undefined)
      .sort((left, right) => left.chunk_index! - right.chunk_index!);
    if (!chunks.length) return undefined;
    const parts = chunks.map((chunk) => decodeBase64(chunk.data!));

    const keys = keysByFileId.get(fileId);
    if (keys) {
      const plain = await decryptBlob(concatBytes(parts), keys.keyB64, keys.nonceB64);
      if (!plain) return undefined;
      const mimeType = mimeByFileId.get(fileId) || 'application/octet-stream';
      return { blob: new Blob([plain as BlobPart], { type: mimeType }), mimeType };
    }
    const mimeType = chunks[0].mime_type || 'application/octet-stream';
    return { blob: new Blob(parts, { type: mimeType }), mimeType };
  }

  function downloadMedia({
    url, mediaFormat, start, end,
  }: { url: string; mediaFormat: number; start?: number; end?: number }) {
    // Progressive-запросы приходят из service worker'а с абсолютным URL
    // вида http://host/progressive/document<id>
    const normalizedUrl = url.replace(/^.*\/progressive\//, '');
    const avatarMatch = normalizedUrl.match(/^(?:avatar|profile)[^?]*\?(.+)$/);
    const mediaMatch = normalizedUrl.match(MEDIA_URL_REGEX);
    // Превью-хэши видео (document<id>?size=x) — миниатюр на проводе нет;
    // не отдавать полный файл в <img>
    if (normalizedUrl.startsWith('document') && /[?&]size=/.test(normalizedUrl)) {
      // Миниатюр на проводе нет. Картинки (стикеры/эмодзи) отдаём тем же
      // блобом, для видео — прозрачную заглушку: undefined заставлял tt
      // ретраить запрос по кругу
      const thumbFileId = normalizedUrl.match(MEDIA_URL_REGEX)?.[1];
      const cachedFull = thumbFileId ? cacheByFileId.get(thumbFileId) : undefined;
      if (!cachedFull) return Promise.resolve(buildThumbPlaceholder());
      return cachedFull.then((result) => (result && result.mimeType.startsWith('image/')
        ? { dataBlob: result.blob, mimeType: result.mimeType }
        : buildThumbPlaceholder()));
    }
    if (normalizedUrl.startsWith('staticMap:')) {
      if (mediaFormat === PROGRESSIVE_MEDIA_FORMAT) return Promise.resolve(undefined);
      return renderStaticMap(normalizedUrl);
    }
    const fileId = avatarMatch ? avatarMatch[1] : mediaMatch?.[1];
    if (!fileId) return Promise.resolve(undefined);

    // Прогрессивный плеер: качаем окно, а не файл целиком (кроме уже
    // скачанных целиком — тогда режем локальный блоб)
    if (mediaFormat === PROGRESSIVE_MEDIA_FORMAT && !cacheByFileId.has(fileId) && keysByFileId.has(fileId)) {
      return downloadRange(fileId, start || 0, end);
    }
    let cached = cacheByFileId.get(fileId);
    if (!cached) {
      cached = downloadBlob(fileId);
      cacheByFileId.set(fileId, cached);
      cached.then((result) => {
        if (result) noteCachedBlob(fileId, result.blob.size);
      }).catch(() => cacheByFileId.delete(fileId));
    } else if (blobSizeByFileId.has(fileId)) {
      // touch — LRU-порядок
      noteCachedBlob(fileId, blobSizeByFileId.get(fileId)!);
    }
    return cached.then(async (result) => {
      if (!result) return undefined;
      if (mediaFormat === PROGRESSIVE_MEDIA_FORMAT) {
        const buffer = await result.blob.arrayBuffer();
        const slice = buffer.slice(start || 0, end !== undefined ? end + 1 : undefined);
        return { arrayBuffer: slice, mimeType: result.mimeType, fullSize: buffer.byteLength };
      }
      return { dataBlob: result.blob, mimeType: result.mimeType };
    });
  }

  function buildThumbPlaceholder() {
    const bytes = decodeBase64(TRANSPARENT_PNG_BASE64);
    return { dataBlob: new Blob([bytes], { type: 'image/png' }), mimeType: 'image/png' };
  }

  const tileCache = new Map<string, Promise<ImageBitmap | undefined>>();

  function fetchTile(z: number, x: number, y: number): Promise<ImageBitmap | undefined> {
    const key = `${z}/${x}/${y}`;
    let cached = tileCache.get(key);
    if (cached) return cached;
    cached = (async () => {
      const store = deps.getStore();
      // Один повтор: шард мог не успеть (проверка токена/сеть) — серый тайл хуже паузы
      for (let attempt = 0; attempt < 2; attempt++) {
        const event = buildWireEvent(store.self, deps.getToken(), { z, x, y });
        const raw = await requireConnection()
          .request(TOPIC_PREVIEW_MAP_TILE, JSON.stringify(event), MAP_TILE_TIMEOUT_MS)
          .catch((error: unknown) => {
            diagLog('map', `tile ${key}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          });
        const parsed = raw ? JSON.parse(raw) as { ok?: boolean; png_base64?: string; error?: string } : undefined;
        if (parsed?.ok && parsed.png_base64) {
          const bytes = Uint8Array.from(atob(parsed.png_base64), (c) => c.charCodeAt(0));
          return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        }
        diagLog('map', `tile ${key}: ${parsed?.error || 'empty'}`);
        await new Promise((resolve) => {
          setTimeout(resolve, MAP_TILE_RETRY_MS);
        });
      }
      return undefined;
    })();
    if (tileCache.size >= TILE_CACHE_LIMIT) {
      const oldest = tileCache.keys().next().value;
      if (oldest !== undefined) {
        const evicted = tileCache.get(oldest);
        tileCache.delete(oldest);
        evicted?.then((bitmap) => bitmap?.close()).catch(() => undefined);
      }
    }
    tileCache.set(key, cached);
    cached.then((bitmap) => {
      if (!bitmap) tileCache.delete(key);
    }).catch(() => tileCache.delete(key));
    return cached;
  }

  async function renderStaticMap(url: string): Promise<{ dataBlob: Blob; mimeType: string } | undefined> {
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const lat = Number(params.get('lat'));
    const long = Number(params.get('long'));
    const width = Number(params.get('w')) || 400;
    const height = Number(params.get('h')) || 300;
    const zoom = Math.min(19, Math.max(0, Math.round(Number(params.get('zoom')) || 16)));
    const scale = Math.min(3, Math.max(1, Number(params.get('scale')) || 1));
    if (!Number.isFinite(lat) || !Number.isFinite(long)) return undefined;
    // Web Mercator: центр в «тайловых пикселях»
    const n = 2 ** zoom;
    const latRad = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
    const centerX = ((long + 180) / 360) * n * MAP_TILE_SIZE;
    const centerY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * MAP_TILE_SIZE;
    const left = centerX - width / 2;
    const top = centerY - height / 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#e8e6e1';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tiles: Promise<void>[] = [];
    for (let tx = Math.floor(left / MAP_TILE_SIZE); tx <= Math.floor((left + width) / MAP_TILE_SIZE); tx++) {
      for (let ty = Math.floor(top / MAP_TILE_SIZE); ty <= Math.floor((top + height) / MAP_TILE_SIZE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wrappedX = ((tx % n) + n) % n;
        tiles.push(fetchTile(zoom, wrappedX, ty).then((bitmap) => {
          if (!bitmap) return;
          ctx.drawImage(
            bitmap,
            Math.round((tx * MAP_TILE_SIZE - left) * scale),
            Math.round((ty * MAP_TILE_SIZE - top) * scale),
            Math.ceil(MAP_TILE_SIZE * scale),
            Math.ceil(MAP_TILE_SIZE * scale),
          );
        }).catch((error: unknown) => {
          diagLog('map', `tile error: ${error instanceof Error ? error.message : String(error)}`);
        }));
      }
    }
    await Promise.all(tiles);
    diagLog('map', `rendered ${tiles.length} tiles z${zoom}`);
    const blob = await new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((result) => resolve(result || undefined), 'image/png');
    });
    return blob ? { dataBlob: blob, mimeType: 'image/png' } : undefined;
  }

  function rememberKeys(content: WireMessageContent) {
    if (content.file_id && content.file_key && content.file_nonce) {
      keysByFileId.set(content.file_id, { keyB64: content.file_key, nonceB64: content.file_nonce });
      if (content.mime) mimeByFileId.set(content.file_id, content.mime);
    }
  }

  function isPhotoAttachment(attachment: NonNullable<SendMessageParams['attachment']>) {
    return Boolean(
      attachment.mimeType.startsWith('image/') && attachment.quick && !attachment.shouldSendAsFile,
    );
  }

  function isVideoAttachment(attachment: NonNullable<SendMessageParams['attachment']>) {
    return Boolean(
      attachment.mimeType.startsWith('video/') && attachment.quick
      && !attachment.shouldSendAsFile && !attachment.isRoundVideo,
    );
  }

  function buildLocalContent(uuid: string, params: SendMessageParams): ApiMessage['content'] {
    const { attachment, text, entities } = params;
    const caption = text ? { text: { text } } : {};
    if (!attachment) return { text: { text: text || '', entities } };
    if (attachment.voice) {
      return {
        voice: {
          mediaType: 'voice',
          id: uuid,
          duration: attachment.voice.duration,
          waveform: attachment.voice.waveform,
          size: attachment.size,
        },
      };
    }
    if (attachment.isRoundVideo || isVideoAttachment(attachment)) {
      return {
        ...(attachment.isRoundVideo ? {} : caption),
        video: {
          mediaType: 'video',
          id: uuid,
          isRound: attachment.isRoundVideo,
          mimeType: attachment.mimeType,
          duration: attachment.quick?.duration || 1,
          fileName: attachment.filename,
          width: attachment.quick?.width,
          height: attachment.quick?.height,
          size: attachment.size,
          blobUrl: attachment.blobUrl,
          previewBlobUrl: attachment.previewBlobUrl,
        },
      };
    }
    if (attachment.audio) {
      return {
        ...caption,
        audio: {
          mediaType: 'audio',
          id: uuid,
          size: attachment.size,
          mimeType: attachment.mimeType,
          fileName: attachment.filename,
          duration: attachment.audio.duration,
          title: attachment.audio.title,
          performer: attachment.audio.performer,
        },
      };
    }
    if (isPhotoAttachment(attachment)) {
      return {
        ...caption,
        photo: {
          mediaType: 'photo',
          id: uuid,
          date: Math.floor(Date.now() / 1000),
          blobUrl: attachment.blobUrl,
          sizes: [
            { type: 'x', width: attachment.quick!.width, height: attachment.quick!.height },
            { type: 'y', width: attachment.quick!.width, height: attachment.quick!.height },
          ],
        },
      };
    }
    return {
      ...caption,
      document: {
        mediaType: 'document',
        id: uuid,
        fileName: attachment.filename,
        size: attachment.size,
        mimeType: attachment.mimeType,
        previewBlobUrl: attachment.previewBlobUrl,
      },
    };
  }

  function detectWebPage(text?: string) {
    if (!text) return undefined;
    const match = text.match(URL_REGEX);
    if (!match) return undefined;
    const url = match[0];
    try {
      return { url, site_name: new URL(url).hostname };
    } catch {
      return undefined;
    }
  }

  // Богатое превью: шард ходит наружу (SSRF-safe), клиент получает OG-метаданные.
  // Возвращает undefined при таймауте/ошибке — отправка деградирует к hostname
  async function fetchWebPagePreview(text?: string, timeoutMs = 1500) {
    const fallback = detectWebPage(text);
    if (!fallback) return undefined;
    const connection = deps.getConnection();
    if (!connection) return fallback;
    try {
      const event = buildWireEvent(deps.getStore().self, deps.getToken(), { url: fallback.url });
      const raw = await Promise.race([
        connection.request(TOPIC_PREVIEW_FETCH, JSON.stringify(event)),
        new Promise<string>((_, reject) => { window.setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
      ]);
      const response = JSON.parse(raw) as {
        ok?: boolean;
        webpage?: { url: string; site_name?: string; title?: string; description?: string };
      };
      const wp = response.webpage;
      if (response.ok && wp) {
        return {
          url: wp.url,
          site_name: wp.site_name || fallback.site_name,
          title: wp.title,
          description: wp.description,
        };
      }
    } catch {
      // Таймаут/ошибка — деградируем к hostname
    }
    return fallback;
  }

  function messageToWireContent(message: ApiMessage): Record<string, unknown> | undefined {
    const content = message.content;
    if (content.text && !content.photo && !content.document && !content.sticker) {
      return {
        kind: 'text',
        text: content.text.text,
        entities: apiEntitiesToWire(content.text.entities),
      };
    }
    const mediaId = content.photo?.id || content.document?.id || content.sticker?.id
      || content.video?.id || content.voice?.id || content.audio?.id;
    if (!mediaId) return undefined;
    const keys = keysByFileId.get(mediaId);
    const cryptoFields = keys ? { file_key: keys.keyB64, file_nonce: keys.nonceB64 } : {};
    if (content.voice) {
      return {
        kind: 'voice',
        file_id: mediaId,
        duration_secs: Math.max(1, Math.round(content.voice.duration)),
        mime: mimeByFileId.get(mediaId) || 'audio/ogg',
        size_bytes: content.voice.size,
        waveform: content.voice.waveform,
        ...cryptoFields,
      };
    }
    if (content.video?.isRound) {
      return {
        kind: 'video_note',
        file_id: mediaId,
        duration_secs: Math.max(1, Math.round(content.video.duration)),
        width: content.video.width || 384,
        height: content.video.height || 384,
        mime: content.video.mimeType,
        size_bytes: content.video.size,
        ...cryptoFields,
      };
    }
    if (content.audio) {
      return {
        kind: 'file',
        file_id: mediaId,
        filename: content.audio.fileName,
        mime: content.audio.mimeType,
        size_bytes: content.audio.size,
        duration_secs: Math.round(content.audio.duration) || undefined,
        audio_title: content.audio.title,
        audio_performer: content.audio.performer,
        ...cryptoFields,
      };
    }
    if (content.video?.isGif) {
      return {
        kind: 'gif',
        file_id: mediaId,
        filename: content.video.fileName,
        mime: content.video.mimeType,
        width: content.video.width || 240,
        height: content.video.height || 240,
        duration_secs: Math.round(content.video.duration),
        size_bytes: content.video.size,
        ...cryptoFields,
      };
    }
    if (content.video) {
      return {
        kind: 'video',
        file_id: mediaId,
        duration_secs: Math.max(1, Math.round(content.video.duration)),
        width: content.video.width || 640,
        height: content.video.height || 480,
        mime: content.video.mimeType,
        size_bytes: content.video.size,
        ...cryptoFields,
      };
    }
    if (content.sticker) {
      return {
        kind: 'sticker',
        file_id: mediaId,
        filename: content.sticker.emoji || '⭐',
        mime: mimeByFileId.get(mediaId) || 'image/png',
        width: content.sticker.width,
        height: content.sticker.height,
        ...cryptoFields,
      };
    }
    if (content.photo) {
      return {
        kind: 'photo', file_id: mediaId, width: 0, height: 0, mime: 'image/jpeg', ...cryptoFields,
      };
    }
    return {
      kind: 'file',
      file_id: mediaId,
      filename: content.document!.fileName,
      mime: content.document!.mimeType,
      size_bytes: content.document!.size,
      ...cryptoFields,
    };
  }

  // LRU по байтам: при превышении бюджета выкидываем самые старые записи
  const blobSizeByFileId = new Map<string, number>();
  let blobCacheBytes = 0;

  function noteCachedBlob(fileId: string, size: number) {
    const previous = blobSizeByFileId.get(fileId) || 0;
    blobCacheBytes += size - previous;
    blobSizeByFileId.delete(fileId);
    blobSizeByFileId.set(fileId, size);
    while (blobCacheBytes > BLOB_CACHE_BUDGET_BYTES && blobSizeByFileId.size > 1) {
      const oldest = blobSizeByFileId.keys().next().value;
      if (oldest === undefined || oldest === fileId) break;
      blobCacheBytes -= blobSizeByFileId.get(oldest) || 0;
      blobSizeByFileId.delete(oldest);
      cacheByFileId.delete(oldest);
    }
  }

  function cacheBlob(fileId: string, blob: Blob, mimeType: string) {
    cacheByFileId.set(fileId, Promise.resolve({ blob, mimeType }));
    noteCachedBlob(fileId, blob.size);
  }

  function cacheBlobIfAbsent(fileId: string, blob: Blob, mimeType: string) {
    if (!cacheByFileId.has(fileId)) cacheBlob(fileId, blob, mimeType);
  }

  return {
    buildLocalContent,
    cacheBlob,
    cacheBlobIfAbsent,
    clearCache: () => {
      cacheByFileId.clear();
      blobSizeByFileId.clear();
      blobCacheBytes = 0;
      tileCache.clear();
      chunkCacheByFileId.clear();
      metaByFileId.clear();
    },
    detectWebPage,
    fetchWebPagePreview,
    downloadBlob,
    downloadMedia,
    getCached: (fileId: string) => cacheByFileId.get(fileId),
    getMediaKeys: (fileId: string) => keysByFileId.get(fileId),
    getCloudRecipients,
    isPhotoAttachment,
    isVideoAttachment,
    messageToWireContent,
    rememberKeys,
    uploadBlob,
  };
}
