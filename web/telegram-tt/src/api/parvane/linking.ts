// Авто-линковка нового устройства: криптография передачи E2E-состояния.
// Обе стороны генерируют эфемерные ECDH-пары (P-256, приватный ключ не
// экстрагируется и живёт только в памяти вкладки); общий секрет → HKDF →
// AES-GCM. Сервер видит только публичные ключи и запечатанный бокс.
// Сверка SAS-кода (отпечаток эфемерного ключа нового устройства) на старом
// устройстве защищает от вора пароля, который подсунул бы СВОЙ оффер.

const HKDF_INFO = 'parvane-link-v1';
const SAS_MODULUS = 1000000; // 6 цифр

export type LinkBoxPayload = {
  file_id: string;
  file_key: string;
  file_nonce: string;
};

export async function generateLinkKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}

export async function exportLinkPublicKey(keyPair: CryptoKeyPair): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return bytesToBase64(new Uint8Array(raw));
}

// 6-значный код из отпечатка эфемерного ключа НОВОГО устройства: обе стороны
// считают его от одного и того же оффера
export async function sasCodeForEphPub(ephPubB64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytesToBuffer(base64ToBytes(ephPubB64)));
  const view = new DataView(digest);
  const code = view.getUint32(0) % SAS_MODULUS;
  return code.toString().padStart(6, '0');
}

export async function sealLinkBox(
  ownPrivate: CryptoKey,
  peerPubB64: string,
  payload: LinkBoxPayload,
): Promise<string> {
  const key = await deriveLinkKey(ownPrivate, peerPubB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bytesToBuffer(iv) }, key, bytesToBuffer(plaintext),
  );
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(packed);
}

export async function openLinkBox(
  ownPrivate: CryptoKey,
  peerPubB64: string,
  boxB64: string,
): Promise<LinkBoxPayload | undefined> {
  try {
    const packed = base64ToBytes(boxB64);
    const iv = packed.subarray(0, 12);
    const ciphertext = packed.subarray(12);
    const key = await deriveLinkKey(ownPrivate, peerPubB64);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesToBuffer(iv) }, key, bytesToBuffer(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as LinkBoxPayload;
  } catch {
    return undefined;
  }
}

async function deriveLinkKey(ownPrivate: CryptoKey, peerPubB64: string): Promise<CryptoKey> {
  const peerKey = await crypto.subtle.importKey(
    'raw', bytesToBuffer(base64ToBytes(peerPubB64)),
    { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, ownPrivate, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new ArrayBuffer(32),
      info: bytesToBuffer(new TextEncoder().encode(HKDF_INFO)),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function bytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
