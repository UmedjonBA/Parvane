// E2E медиа: AES-256-GCM через WebCrypto. Wire-совместимо с десктопным/android
// blobcrypt (parvane-core): key 32 байта, nonce 12. Блоб грузится в cloud
// ШИФРТЕКСТОМ; key+nonce едут в E2E-обёрнутом content, не серверу.
//
// P-24 / правило BLOB-1 (conformance): формат v2 — чанковый AEAD. Каждый чанк
// plaintext (по умолчанию 256 КиБ) шифруется отдельно с собственным тегом,
// поэтому прогрессивный плеер проверяет целостность КАЖДОГО окна до того, как
// отдать байты декодеру. Раскладка (big-endian):
//   "PVB2" | u32 chunkSize | для i in 0..n: ct_i (≤ chunkSize) | tag_i (16)
//   n = max(1, ceil(len / chunkSize)); nonce_i = nonce XOR (0^8 || u32 i);
//   AAD_i = "PVB2" | u32 chunkSize | u32 i | u32 n.
// Legacy v1 (данные || tag без заголовка) читается decryptBlob целиком; окна
// из v1 больше не расшифровываются без проверки (P-24).

const KEY_LEN = 32;
const NONCE_LEN = 12;
export const BLOB_TAG_BYTES = 16;
export const BLOB_HEADER_BYTES = 8;
export const BLOB_DEFAULT_CHUNK = 256 * 1024;
const BLOB_MIN_CHUNK = 1024;
const BLOB_MAX_CHUNK = 8 * 1024 * 1024;
const MAGIC = [0x50, 0x56, 0x42, 0x32]; // "PVB2"

export type BlobHeader = { chunkSize: number };

function toBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function fromBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// WebCrypto ждёт BufferSource с ArrayBuffer (не SharedArrayBuffer) — копируем
// в свежий ArrayBuffer, чтобы удовлетворить строгую типизацию lib.dom
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

function putU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, false);
}

function aadFor(chunkSize: number, index: number, total: number): ArrayBuffer {
  const out = new ArrayBuffer(16);
  const bytes = new Uint8Array(out);
  bytes.set(MAGIC, 0);
  const view = new DataView(out);
  putU32(view, 4, chunkSize);
  putU32(view, 8, index);
  putU32(view, 12, total);
  return out;
}

function nonceFor(nonce: Uint8Array, index: number): ArrayBuffer {
  const out = new ArrayBuffer(NONCE_LEN);
  const bytes = new Uint8Array(out);
  bytes.set(nonce);
  bytes[8] ^= (index >>> 24) & 0xff;
  bytes[9] ^= (index >>> 16) & 0xff;
  bytes[10] ^= (index >>> 8) & 0xff;
  bytes[11] ^= index & 0xff;
  return out;
}

/** Заголовок v2 или undefined (legacy v1 / битый заголовок). */
export function parseBlobHeader(bytes: Uint8Array): BlobHeader | undefined {
  if (bytes.length < BLOB_HEADER_BYTES) return undefined;
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) return undefined;
  const chunkSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  if (chunkSize < BLOB_MIN_CHUNK || chunkSize > BLOB_MAX_CHUNK) return undefined;
  return { chunkSize };
}

export function blobChunkCount(cipherLength: number, header: BlobHeader) {
  if (cipherLength < BLOB_HEADER_BYTES + BLOB_TAG_BYTES) return 0;
  const full = header.chunkSize + BLOB_TAG_BYTES;
  return Math.ceil((cipherLength - BLOB_HEADER_BYTES) / full);
}

export function blobPlaintextSize(cipherLength: number, header: BlobHeader) {
  const n = blobChunkCount(cipherLength, header);
  if (!n) return 0;
  return cipherLength - BLOB_HEADER_BYTES - n * BLOB_TAG_BYTES;
}

/** Смещение чанка `index` (ct||tag) в шифртексте v2. */
export function blobChunkOffset(index: number, header: BlobHeader) {
  return BLOB_HEADER_BYTES + index * (header.chunkSize + BLOB_TAG_BYTES);
}

async function importKey(rawKey: Uint8Array, usage: KeyUsage) {
  return crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-GCM', false, [usage]);
}

/** Детерминированное шифрование v2 (тесты, кросс-клиентские векторы). */
export async function encryptBlobWithKey(
  plain: Uint8Array, rawKey: Uint8Array, nonce: Uint8Array, chunkSize = BLOB_DEFAULT_CHUNK,
): Promise<Uint8Array> {
  if (rawKey.length !== KEY_LEN || nonce.length !== NONCE_LEN) throw new Error('blobcrypt: bad key/nonce');
  if (chunkSize < BLOB_MIN_CHUNK || chunkSize > BLOB_MAX_CHUNK) throw new Error('blobcrypt: bad chunk size');
  const total = plain.length === 0 ? 1 : Math.ceil(plain.length / chunkSize);
  const key = await importKey(rawKey, 'encrypt');
  const out = new Uint8Array(BLOB_HEADER_BYTES + plain.length + total * BLOB_TAG_BYTES);
  out.set(MAGIC, 0);
  putU32(new DataView(out.buffer), 4, chunkSize);
  let cursor = BLOB_HEADER_BYTES;
  for (let index = 0; index < total; index++) {
    const slice = plain.subarray(index * chunkSize, (index + 1) * chunkSize);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonceFor(nonce, index), additionalData: aadFor(chunkSize, index, total) },
      key,
      toArrayBuffer(slice),
    );
    out.set(new Uint8Array(sealed), cursor);
    cursor += sealed.byteLength;
  }
  return out;
}

export async function encryptBlob(plain: Uint8Array): Promise<{
  ciphertext: Uint8Array; keyB64: string; nonceB64: string;
}> {
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const ciphertext = await encryptBlobWithKey(plain, rawKey, nonce);
  return { ciphertext, keyB64: toBase64(rawKey), nonceB64: toBase64(nonce) };
}

/**
 * Расшифровать чанки [firstChunk, firstChunk + k) v2-шифртекста: `chunks` — подряд
 * идущие байты этих чанков (каждый ct||tag). Каждый тег проверяется; любая подделка,
 * усечение или перестановка → undefined.
 */
export async function decryptBlobChunks(
  chunks: Uint8Array, keyB64: string, nonceB64: string, header: BlobHeader,
  firstChunk: number, totalChunks: number,
): Promise<Uint8Array | undefined> {
  try {
    const rawKey = fromBase64(keyB64);
    const nonce = fromBase64(nonceB64);
    if (rawKey.length !== KEY_LEN || nonce.length !== NONCE_LEN || totalChunks <= 0) return undefined;
    const key = await importKey(rawKey, 'decrypt');
    const full = header.chunkSize + BLOB_TAG_BYTES;
    const parts: Uint8Array[] = [];
    let pos = 0;
    let index = firstChunk;
    let plainLength = 0;
    while (pos < chunks.length) {
      if (index >= totalChunks) return undefined;
      const len = Math.min(full, chunks.length - pos);
      if (index + 1 < totalChunks && len !== full) return undefined;
      const opened = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonceFor(nonce, index), additionalData: aadFor(header.chunkSize, index, totalChunks) },
        key,
        toArrayBuffer(chunks.subarray(pos, pos + len)),
      );
      const bytes = new Uint8Array(opened);
      parts.push(bytes);
      plainLength += bytes.length;
      pos += len;
      index++;
    }
    const out = new Uint8Array(plainLength);
    let cursor = 0;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  } catch {
    return undefined;
  }
}

export async function decryptBlob(
  ciphertext: Uint8Array, keyB64: string, nonceB64: string,
): Promise<Uint8Array | undefined> {
  const header = parseBlobHeader(ciphertext);
  if (header) {
    const total = blobChunkCount(ciphertext.length, header);
    if (!total) return undefined;
    return decryptBlobChunks(ciphertext.subarray(BLOB_HEADER_BYTES), keyB64, nonceB64, header, 0, total);
  }
  // legacy v1: данные || tag, один GCM без AAD
  try {
    const rawKey = fromBase64(keyB64);
    const nonce = fromBase64(nonceB64);
    if (rawKey.length !== KEY_LEN || nonce.length !== NONCE_LEN) return undefined;
    const key = await importKey(rawKey, 'decrypt');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    // Не сошёлся GCM-tag (подделка) или битый ключ
    return undefined;
  }
}
