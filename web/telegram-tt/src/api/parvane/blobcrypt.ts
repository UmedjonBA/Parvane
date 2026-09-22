// E2E медиа: AES-256-GCM через WebCrypto. Wire-совместимо с десктопным
// blobcrypt (parvane-core): key 32 байта, nonce 12, ciphertext = данные||tag(16)
// (WebCrypto добавляет 128-битный tag в конец — тот же формат). Блоб грузится
// в cloud ШИФРТЕКСТОМ; key+nonce едут в E2E-обёрнутом content, не серверу.

const KEY_LEN = 32;
const NONCE_LEN = 12;

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

export async function encryptBlob(plain: Uint8Array): Promise<{
  ciphertext: Uint8Array; keyB64: string; nonceB64: string;
}> {
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_LEN));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(plain),
  );
  return {
    ciphertext: new Uint8Array(encrypted),
    keyB64: toBase64(rawKey),
    nonceB64: toBase64(nonce),
  };
}

export async function decryptBlob(
  ciphertext: Uint8Array, keyB64: string, nonceB64: string,
): Promise<Uint8Array | undefined> {
  try {
    const rawKey = fromBase64(keyB64);
    const nonce = fromBase64(nonceB64);
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    // Не сошёлся GCM-tag (подделка) или битый ключ
    return undefined;
  }
}

// Range-дешифровка окна GCM-шифртекста БЕЗ тега: GCM шифрует данные как
// AES-CTR со счётчиком nonce||u32be(2 + блок) (J0 = nonce||1, данные с inc32).
// Так видео стримится кусками с того же файла, что и целиком (формат на
// проводе не меняется, desktop не затронут). Тег не проверяется — только для
// прогрессивного плеера; целостность целого файла проверяет decryptBlob.
// Импорт AES-CTR ключа на каждое окно видео дорог — держим non-extractable
// CryptoKey на файл (ключ сессии, не пишется на диск)
const CTR_KEY_CACHE_LIMIT = 32;
const ctrKeyCache = new Map<string, Promise<CryptoKey>>();

function importCtrKey(rawKey: Uint8Array, cacheKey: string) {
  let cached = ctrKeyCache.get(cacheKey);
  if (!cached) {
    cached = crypto.subtle.importKey('raw', toArrayBuffer(rawKey), 'AES-CTR', false, ['encrypt', 'decrypt']);
    if (ctrKeyCache.size >= CTR_KEY_CACHE_LIMIT) {
      const oldest = ctrKeyCache.keys().next().value;
      if (oldest !== undefined) ctrKeyCache.delete(oldest);
    }
    ctrKeyCache.set(cacheKey, cached);
    cached.catch(() => ctrKeyCache.delete(cacheKey));
  }
  return cached;
}

export async function decryptRange(
  ciphertext: Uint8Array, keyB64: string, nonceB64: string, byteOffset: number,
): Promise<Uint8Array | undefined> {
  if (byteOffset % 16 !== 0) return undefined;
  try {
    const rawKey = fromBase64(keyB64);
    const nonce = fromBase64(nonceB64);
    if (rawKey.length !== KEY_LEN || nonce.length !== NONCE_LEN) return undefined;
    const counter = new Uint8Array(16);
    counter.set(nonce, 0);
    const blockCounter = (2 + byteOffset / 16) >>> 0;
    new DataView(counter.buffer).setUint32(12, blockCounter, false);
    const key = await importCtrKey(rawKey, keyB64);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: toArrayBuffer(counter), length: 32 }, key, toArrayBuffer(ciphertext),
    );
    return new Uint8Array(plain);
  } catch {
    return undefined;
  }
}

// Ключи потоковой проверки тега GCM (gcmVerify.ts): H = AES_K(0^128) и
// E_K(J0), J0 = nonce ‖ 00000001. AES-CTR над 16 нулевыми байтами с таким
// начальным счётчиком даёт ровно шифр одного блока
export async function deriveGhashKeys(keyB64: string, nonceB64: string) {
  const rawKey = fromBase64(keyB64);
  const nonce = fromBase64(nonceB64);
  if (rawKey.length !== KEY_LEN || nonce.length !== NONCE_LEN) throw new Error('неверный ключ файла');
  const key = await importCtrKey(rawKey, keyB64);
  const zeros = new ArrayBuffer(16);
  const hCounter = new Uint8Array(16);
  const j0 = new Uint8Array(16);
  j0.set(nonce, 0);
  j0[15] = 1;
  const [h, ej0] = await Promise.all([
    crypto.subtle.encrypt({ name: 'AES-CTR', counter: toArrayBuffer(hCounter), length: 32 }, key, zeros),
    crypto.subtle.encrypt({ name: 'AES-CTR', counter: toArrayBuffer(j0), length: 32 }, key, zeros),
  ]);
  return { h: new Uint8Array(h), ej0: new Uint8Array(ej0) };
}
