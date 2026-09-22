import { describe, expect, it } from 'vitest';

import { deriveGhashKeys, encryptBlob } from './blobcrypt';
import { createGcmTagVerifier } from './gcmVerify';

// Границы блоков AES (16) и НАСТОЯЩИХ транспортных фрагментов: фрагмент —
// 192 КиБ = 196608 байт (`api/parvane/media.ts` UPLOAD_CHUNK_BYTES), а не
// десятичные 192000, как было здесь раньше
const CHUNK_BYTES = 192 * 1024;
const LENGTHS = [0, 15, 16, 17, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 256 * 1024 * 3 + 5];

function randomBytes(length: number) {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65536)));
  }
  return bytes;
}

function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function verify(file: Uint8Array, keyB64: string, nonceB64: string, chunkSize: number) {
  const verifier = createGcmTagVerifier(await deriveGhashKeys(keyB64, nonceB64), file.length);
  for (const chunk of chunks(file, chunkSize)) verifier.update(chunk);
  return verifier.finish();
}

describe('streaming GCM tag verification', () => {
  it.each(LENGTHS)('matches the WebCrypto tag for %i plaintext bytes', async (length) => {
    const { ciphertext, keyB64, nonceB64 } = await encryptBlob(randomBytes(length));
    expect(await verify(ciphertext, keyB64, nonceB64, 192 * 1024)).toBe(true);
    expect(await verify(ciphertext, keyB64, nonceB64, 256 * 1024)).toBe(true);
    // Нечётные куски: хвост блока и тег разрезаны между вызовами update
    if (length <= 192001) expect(await verify(ciphertext, keyB64, nonceB64, 7)).toBe(true);
  });

  it('handles a tag split across the last two chunks', async () => {
    const { ciphertext, keyB64, nonceB64 } = await encryptBlob(randomBytes(192 * 1024 - 8));
    // ciphertext = 192К - 8 + 16 байт: последние 8 байт тега уезжают во второй фрагмент
    expect(ciphertext.length).toBe(192 * 1024 + 8);
    expect(await verify(ciphertext, keyB64, nonceB64, 192 * 1024)).toBe(true);
  });

  it('rejects a flipped byte in the middle and in the tag', async () => {
    const { ciphertext, keyB64, nonceB64 } = await encryptBlob(randomBytes(400000));
    const middle = ciphertext.slice();
    middle[200000] ^= 1;
    expect(await verify(middle, keyB64, nonceB64, 192 * 1024)).toBe(false);
    const tagged = ciphertext.slice();
    tagged[tagged.length - 1] ^= 0x80;
    expect(await verify(tagged, keyB64, nonceB64, 192 * 1024)).toBe(false);
  });

  it('rejects a truncated file', async () => {
    const { ciphertext, keyB64, nonceB64 } = await encryptBlob(randomBytes(1000));
    const verifier = createGcmTagVerifier(await deriveGhashKeys(keyB64, nonceB64), ciphertext.length);
    verifier.update(ciphertext.subarray(0, ciphertext.length - 1));
    expect(verifier.finish()).toBe(false);
  });
});
