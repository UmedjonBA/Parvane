// @vitest-environment node
// P-24 / BLOB-1: чанковый AEAD медиа-блобов. Векторы совпадают с parvane-core
// (desktop/parvane-core/tests/blobcrypt_tests.cpp).
import { webcrypto } from 'node:crypto';
import {
  describe, expect, it,
} from 'vitest';

import {
  BLOB_HEADER_BYTES,
  BLOB_TAG_BYTES,
  blobChunkCount,
  blobChunkOffset,
  blobPlaintextSize,
  decryptBlob,
  decryptBlobChunks,
  encryptBlob,
  encryptBlobWithKey,
  parseBlobHeader,
} from './blobcrypt';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const KEY = new Uint8Array(32).fill(1);
const NONCE = new Uint8Array(12).fill(2);

describe('BLOB-1: чанковый AEAD v2', () => {
  it('кросс-клиентский вектор совпадает с parvane-core (chunk 1024, 1500×"a")', async () => {
    const plain = new Uint8Array(1500).fill(0x61);
    const ct = await encryptBlobWithKey(plain, KEY, NONCE, 1024);
    expect(ct.length).toBe(BLOB_HEADER_BYTES + 1500 + 2 * BLOB_TAG_BYTES);
    // те же значения печатает parvane_blobcrypt_tests (BLOB-1.vector)
    expect(toHex(ct.subarray(0, 24))).toBe('505642320000040066b7a8282b36a09cb2addda93dc6a3d3');
    expect(toHex(ct.subarray(ct.length - 16))).toBe('297636bc1b79f4f72284144a0b0be7e8');
    expect(await decryptBlob(ct, b64(KEY), b64(NONCE))).toEqual(plain);
  });

  it('legacy v1 (данные||tag без заголовка) читается целиком', async () => {
    const v1 = Buffer.from('d7e7Pys5pN2xoNOqfNHzVpFQwpooOo/gVIDan1UXaA==', 'base64');
    const plain = await decryptBlob(new Uint8Array(v1), b64(KEY), b64(NONCE));
    expect(plain && new TextDecoder().decode(plain)).toBe('parvane blob v1');
    expect(parseBlobHeader(new Uint8Array(v1))).toBeUndefined();
  });

  it('окно из проверенных чанков; бит-флип, усечение и перестановка отвергаются', async () => {
    const plain = crypto.getRandomValues(new Uint8Array(3 * 1024 + 77));
    const ct = await encryptBlobWithKey(plain, KEY, NONCE, 1024);
    const header = parseBlobHeader(ct)!;
    expect(header.chunkSize).toBe(1024);
    const total = blobChunkCount(ct.length, header);
    expect(total).toBe(4);
    expect(blobPlaintextSize(ct.length, header)).toBe(plain.length);

    const second = ct.subarray(blobChunkOffset(1, header), blobChunkOffset(2, header));
    const window = await decryptBlobChunks(second, b64(KEY), b64(NONCE), header, 1, total);
    expect(window).toEqual(plain.subarray(1024, 2048));

    const flipped = new Uint8Array(second);
    flipped[5] ^= 1;
    expect(await decryptBlobChunks(flipped, b64(KEY), b64(NONCE), header, 1, total)).toBeUndefined();
    // чанк под чужим индексом (перестановка) и усечённый файл
    expect(await decryptBlobChunks(second, b64(KEY), b64(NONCE), header, 2, total)).toBeUndefined();
    expect(await decryptBlob(ct.subarray(0, blobChunkOffset(3, header)), b64(KEY), b64(NONCE))).toBeUndefined();
    // хвостовой чанк любой длины ≥ tag — но не пустой файл с "лишними" чанками
    expect(await decryptBlobChunks(ct.subarray(BLOB_HEADER_BYTES), b64(KEY), b64(NONCE), header, 0, 3)).toBeUndefined();
  });

  it('encryptBlob даёт v2 со случайным ключом; пустой блоб round-trip', async () => {
    const a = await encryptBlob(new Uint8Array(0));
    const b = await encryptBlob(new Uint8Array(0));
    expect(a.keyB64).not.toBe(b.keyB64);
    expect(parseBlobHeader(a.ciphertext)?.chunkSize).toBe(256 * 1024);
    expect(await decryptBlob(a.ciphertext, a.keyB64, a.nonceB64)).toEqual(new Uint8Array(0));
    expect(await decryptBlob(a.ciphertext, b.keyB64, a.nonceB64)).toBeUndefined();
  });
});
