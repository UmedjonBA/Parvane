// Ручная копия ключей устройства (перенос на другой браузер): конверт
// PBKDF2-SHA256 + AES-GCM под паролем пользователя. Содержимое — устройство v2
// (состояние движка), история v2-эпохи и id устройства (T152); с T110 (7 окт
// 2026) материала v1 (Olm) в копии нет — конверт версии 2, копии версии 1
// (с Olm-аккаунтом) не читаются.

export type KeyBackupPayload = {
  deviceId: string;
  v2: unknown;
  v2History?: unknown;
};

const EXPORT_VERSION = 2;
const EXPORT_MIN_ITERATIONS = 310000;
// P-48: верхняя граница итераций PBKDF2 при импорте (защита от DoS чужим файлом)
export const EXPORT_MAX_ITERATIONS = 5_000_000;
const EXPORT_SALT_MIN = 16;
const EXPORT_SALT_MAX = 64;
const EXPORT_IV_LEN = 12;
export const EXPORT_DATA_MAX = 16 * 1024 * 1024;

/** P-48: проверка конверта бэкапа до KDF: число итераций в [min, max], соль 16..64 байт,
 *  iv 12 байт, данные ≤ 16 МиБ. Число итераций из файла не ниже минимума — подделанный
 *  бэкап с iterations=1 делал бы перебор пароля тривиальным. */
export function validateBackupEnvelope(parsed: {
  iterations?: number; salt: string; iv: string; data: string;
}): { iterations: number; salt: Uint8Array; iv: Uint8Array; data: Uint8Array } {
  const raw = parsed.iterations ?? EXPORT_MIN_ITERATIONS;
  if (!Number.isInteger(raw) || raw > EXPORT_MAX_ITERATIONS) {
    throw new Error('Key backup: unsupported PBKDF2 iteration count.');
  }
  const iterations = Math.max(raw, EXPORT_MIN_ITERATIONS);
  if (typeof parsed.salt !== 'string' || typeof parsed.iv !== 'string' || typeof parsed.data !== 'string') {
    throw new Error('Key backup: malformed envelope.');
  }
  if (parsed.data.length > Math.ceil(EXPORT_DATA_MAX / 3) * 4 + 4) {
    throw new Error('Key backup: payload too large.');
  }
  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(parsed.iv);
  const data = base64ToBytes(parsed.data);
  if (salt.length < EXPORT_SALT_MIN || salt.length > EXPORT_SALT_MAX) {
    throw new Error('Key backup: bad salt length.');
  }
  if (iv.length !== EXPORT_IV_LEN) throw new Error('Key backup: bad iv length.');
  if (data.length < 16 || data.length > EXPORT_DATA_MAX) throw new Error('Key backup: bad payload length.');
  return { iterations, salt, iv, data };
}
// OWASP-2023 минимум для PBKDF2-SHA256. Импорт читает iterations из самого
// бэкапа — старые экспорты на 310k остаются читаемыми
const EXPORT_KDF_ITERATIONS = 600000;

// WebCrypto требует BufferSource с обычным ArrayBuffer
function toStandaloneBuffer(bytes: Uint8Array): ArrayBuffer {
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

async function deriveExportKey(password: string, salt: Uint8Array, iterations = EXPORT_KDF_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw', toStandaloneBuffer(new TextEncoder().encode(password)), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2', hash: 'SHA-256', salt: toStandaloneBuffer(salt), iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function exportEncryptedBackup(password: string, payload: KeyBackupPayload): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveExportKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toStandaloneBuffer(iv) }, key, toStandaloneBuffer(plaintext),
  );
  return JSON.stringify({
    v: EXPORT_VERSION,
    kdf: 'pbkdf2-sha256',
    iterations: EXPORT_KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function importEncryptedBackup(password: string, raw: string): Promise<KeyBackupPayload> {
  const parsed = JSON.parse(raw) as {
    v: number; iterations?: number; salt: string; iv: string; data: string;
  };
  if (parsed.v !== EXPORT_VERSION) throw new Error(`Unsupported key backup version: ${parsed.v}.`);
  // P-48: границы конверта — иначе чужой файл с iterations=10^9 вешает вкладку,
  // а соль/iv неверной длины делают KDF/GCM бессмысленными
  const envelope = validateBackupEnvelope(parsed);
  const key = await deriveExportKey(password, envelope.salt, envelope.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toStandaloneBuffer(envelope.iv) }, key, toStandaloneBuffer(envelope.data),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<KeyBackupPayload>;
  if (!payload || typeof payload.deviceId !== 'string' || !payload.v2 || typeof payload.v2 !== 'object') {
    throw new Error('Key backup: no v2 device in the payload.');
  }
  return { deviceId: payload.deviceId, v2: payload.v2, v2History: payload.v2History };
}
