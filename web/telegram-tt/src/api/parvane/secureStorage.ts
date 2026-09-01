import {
  createStore, del, get, set,
} from 'idb-keyval';

const STORAGE_VERSION = 2;
const STORAGE = createStore('parvane-e2e-v2', 'secure-state');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type EncryptedRecord = {
  version: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

function keyId(user: string) {
  return `key:${user}`;
}

function stateId(user: string) {
  return `state:${user}`;
}

function additionalData(user: string) {
  return encoder.encode(`parvane-e2e-storage:${STORAGE_VERSION}:${user}`).buffer;
}

async function generateProtectionKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export class SecureE2eStorage {
  private constructor(
    private readonly user: string,
    private readonly protectionKey: CryptoKey,
  ) {}

  static async open(user: string) {
    const encrypted = await get<EncryptedRecord>(stateId(user), STORAGE);
    let protectionKey = await get<CryptoKey>(keyId(user), STORAGE);
    if (encrypted && !protectionKey) {
      throw new Error('Encrypted E2E state exists, but its non-extractable protection key is missing.');
    }
    if (!protectionKey) {
      protectionKey = await generateProtectionKey();
      await set(keyId(user), protectionKey, STORAGE);
    }
    return new SecureE2eStorage(user, protectionKey);
  }

  async load<T>() {
    const record = await get<EncryptedRecord>(stateId(this.user), STORAGE);
    if (!record) return undefined;
    if (record.version !== STORAGE_VERSION) {
      throw new Error(`Unsupported E2E storage version: ${record.version}.`);
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: additionalData(this.user) },
      this.protectionKey,
      record.ciphertext,
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  }

  async save(value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(this.user) },
      this.protectionKey,
      encoder.encode(JSON.stringify(value)).buffer,
    );
    const record: EncryptedRecord = {
      version: STORAGE_VERSION,
      iv: iv.buffer,
      ciphertext,
    };
    await set(stateId(this.user), record, STORAGE);
  }

  static async clear(user: string) {
    await Promise.all([
      del(stateId(user), STORAGE),
      del(keyId(user), STORAGE),
    ]);
  }
}

// ── «Keep me signed in»: пароль под тем же non-extractable AES-GCM, что и
// E2E-состояние. Риск не растёт: у кого есть доступ выполнять JS в этом origin
// и читать IndexedDB, у того и так уже E2E-ключи (= доступ ко всем сообщениям).
// Отдельные id, чтобы не пересекаться с E2E-состоянием.
function credKeyId(user: string) {
  return `credkey:${user}`;
}

function credId(user: string) {
  return `cred:${user}`;
}

function credAad(user: string) {
  return encoder.encode(`parvane-cred-storage:${STORAGE_VERSION}:${user}`).buffer;
}

export async function saveSecureCredential(user: string, password: string) {
  let protectionKey = await get<CryptoKey>(credKeyId(user), STORAGE);
  if (!protectionKey) {
    protectionKey = await generateProtectionKey();
    await set(credKeyId(user), protectionKey, STORAGE);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: credAad(user) },
    protectionKey,
    encoder.encode(password).buffer,
  );
  await set(credId(user), { version: STORAGE_VERSION, iv: iv.buffer, ciphertext } satisfies EncryptedRecord, STORAGE);
}

export async function loadSecureCredential(user: string): Promise<string | undefined> {
  const record = await get<EncryptedRecord>(credId(user), STORAGE);
  const protectionKey = await get<CryptoKey>(credKeyId(user), STORAGE);
  if (!record || !protectionKey || record.version !== STORAGE_VERSION) return undefined;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: credAad(user) },
      protectionKey,
      record.ciphertext,
    );
    return decoder.decode(plaintext);
  } catch {
    return undefined;
  }
}

export async function clearSecureCredential(user: string) {
  await Promise.all([del(credId(user), STORAGE), del(credKeyId(user), STORAGE)]);
}

export const secureStorageInternals = {
  keyId,
  stateId,
  store: STORAGE,
  version: STORAGE_VERSION,
};
