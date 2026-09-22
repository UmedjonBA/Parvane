// Потоковая проверка тега AES-GCM целого файла blobcrypt без удержания всего
// шифртекста в памяти. WebCrypto умеет GCM только одним вызовом, поэтому тег
// считается вручную: tag = GHASH_H(C) ⊕ E_K(J0), где H и E_K(J0) получены через
// AES-CTR (blobcrypt.deriveGhashKeys), а GHASH — аудированная реализация
// @noble/ciphers. Формат файла (web и desktop): ciphertext ‖ tag(16), без AAD.
import { GHASH } from '@noble/ciphers/_polyval.js';

const BLOCK = 16;
const TAG_BYTES = 16;

export type GcmTagVerifier = {
  // Байты файла по порядку (ciphertext ‖ tag), любыми кусками
  update: (bytes: Uint8Array) => void;
  // true — тег сошёлся; вызывать после подачи ровно sizeBytes байт
  finish: () => boolean;
  consumedBytes: () => number;
};

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function createGcmTagVerifier(
  { h, ej0 }: { h: Uint8Array; ej0: Uint8Array },
  sizeBytes: number,
): GcmTagVerifier {
  if (sizeBytes < TAG_BYTES) throw new Error('файл короче тега GCM');
  const ciphertextBytes = sizeBytes - TAG_BYTES;
  const ghash = new GHASH(h, ciphertextBytes);
  // GHASH.update дополняет КАЖДЫЙ вход нулями до 16 байт — отдаём только
  // целые блоки, хвост копим до следующего куска
  const pending = new Uint8Array(BLOCK);
  let pendingLength = 0;
  const tag = new Uint8Array(TAG_BYTES);
  let consumed = 0;

  function absorbCiphertext(bytes: Uint8Array) {
    let offset = 0;
    if (pendingLength) {
      const take = Math.min(BLOCK - pendingLength, bytes.length);
      pending.set(bytes.subarray(0, take), pendingLength);
      pendingLength += take;
      offset = take;
      if (pendingLength === BLOCK) {
        ghash.update(pending);
        pendingLength = 0;
      }
    }
    const whole = Math.floor((bytes.length - offset) / BLOCK) * BLOCK;
    if (whole) ghash.update(bytes.subarray(offset, offset + whole));
    const rest = bytes.length - offset - whole;
    if (rest) {
      pending.set(bytes.subarray(offset + whole), 0);
      pendingLength = rest;
    }
  }

  return {
    update(bytes) {
      if (consumed + bytes.length > sizeBytes) throw new Error('байт больше размера файла');
      const ciphertextLeft = Math.max(0, ciphertextBytes - consumed);
      const ciphertextPart = bytes.subarray(0, Math.min(bytes.length, ciphertextLeft));
      if (ciphertextPart.length) absorbCiphertext(ciphertextPart);
      const tagPart = bytes.subarray(ciphertextPart.length);
      if (tagPart.length) tag.set(tagPart, consumed + ciphertextPart.length - ciphertextBytes);
      consumed += bytes.length;
    },
    finish() {
      if (consumed !== sizeBytes) return false;
      if (pendingLength) ghash.update(pending.subarray(0, pendingLength));
      // Блок длин: len(AAD)=0 ‖ len(C) в битах, оба u64 big-endian
      const lengths = new Uint8Array(BLOCK);
      const view = new DataView(lengths.buffer);
      const bits = ciphertextBytes * 8;
      view.setUint32(8, Math.floor(bits / 2 ** 32), false);
      view.setUint32(12, bits >>> 0, false);
      ghash.update(lengths);
      const s = ghash.digest();
      const expected = new Uint8Array(TAG_BYTES);
      for (let index = 0; index < TAG_BYTES; index++) expected[index] = s[index] ^ ej0[index];
      return constantTimeEqual(expected, tag);
    },
    consumedBytes: () => consumed,
  };
}
