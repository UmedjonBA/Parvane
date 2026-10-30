import { PASSCODE_IDB_STORE } from './browser/idb';

const IV_LENGTH = 12;
// Прежний ключ — SHA-256(код + общая константа) без растяжения; читаем только для переноса
const LEGACY_SALT = 'harder better faster stronger';
const KDF_SALT_KEY = 'kdfSalt';
const KDF_SALT_LENGTH = 16;
export const PBKDF2_ITERATIONS = 600000;

let currentPasscodeHash: ArrayBuffer | undefined;

export class UnrecoverablePasscodeError extends Error {}

export function getPasscodeHash() {
  return currentPasscodeHash;
}

export function setPasscodeHash(passcodeHash: ArrayBuffer) {
  currentPasscodeHash = passcodeHash;
}

export async function setupPasscode(passcode: string) {
  const salt = crypto.getRandomValues(new Uint8Array(KDF_SALT_LENGTH));
  currentPasscodeHash = await deriveKey(passcode, salt);
  await PASSCODE_IDB_STORE.set(KDF_SALT_KEY, Array.from(salt));
}

export async function encryptSession(sessionJson?: string, globalJson?: string, sharedStateJson?: string) {
  if (!currentPasscodeHash) {
    // eslint-disable-next-line no-console
    console.error('[api/passcode] Missing current passcode');
    throw new Error('[api/passcode] Missing current passcode');
  }

  await Promise.all([
    storeEncrypted('sessionEncrypted', sessionJson),
    storeEncrypted('globalEncrypted', globalJson),
    storeEncrypted('sharedStateEncrypted', sharedStateJson),
  ]);
}

async function storeEncrypted(key: string, json?: string) {
  if (!json) return;

  const encrypted = await aesEncrypt(json, currentPasscodeHash!);
  await store(key, encrypted);
}

export async function decryptSessionByCurrentHash() {
  if (!currentPasscodeHash) {
    // eslint-disable-next-line no-console
    console.error('[api/passcode] Missing current passcode');
    throw new Error('[api/passcode] Missing current passcode');
  }

  const [sessionEncrypted, globalEncrypted] = await Promise.all([
    load('sessionEncrypted'),
    load('globalEncrypted'),
  ]);

  if (!sessionEncrypted || !globalEncrypted) {
    // eslint-disable-next-line no-console
    console.error('[api/passcode] Missing required stored fields');
    throw new Error('[api/passcode] Missing required stored fields');
  }

  try {
    const [sessionJson, globalJson] = await Promise.all([
      aesDecrypt(sessionEncrypted, currentPasscodeHash),
      aesDecrypt(globalEncrypted, currentPasscodeHash),
    ]);

    return { sessionJson, globalJson };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[api/passcode] Error decrypting session', err);
    throw err;
  }
}

export async function decryptSession(passcode: string) {
  const salt = await loadSalt();
  const passcodeHash = salt ? await deriveKey(passcode, salt) : await legacySha256(passcode);

  const [sessionEncrypted, globalEncrypted, sharedStateEncrypted] = await Promise.all([
    load('sessionEncrypted'),
    load('globalEncrypted'),
    load('sharedStateEncrypted'),
  ]);

  if (!sessionEncrypted || !globalEncrypted) {
    // eslint-disable-next-line no-console
    console.error('[api/passcode] Missing required stored fields');
    throw new UnrecoverablePasscodeError('[api/passcode] Missing required stored fields');
  }

  try {
    // `sharedStateEncrypted` may be absent for sessions locked before it was persisted
    const [sessionJson, globalJson, sharedStateJson] = await Promise.all([
      aesDecrypt(sessionEncrypted, passcodeHash),
      aesDecrypt(globalEncrypted, passcodeHash),
      sharedStateEncrypted ? aesDecrypt(sharedStateEncrypted, passcodeHash) : undefined,
    ]);

    currentPasscodeHash = passcodeHash;

    if (!salt) {
      // Перенос со слабого ключа на PBKDF2 с солью установки: сначала шифртексты, затем соль
      await upgradeLegacyKey(passcode, sessionJson, globalJson, sharedStateJson);
    }

    return { sessionJson, globalJson, sharedStateJson };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[api/passcode] Error decrypting session', err);
    throw err;
  }
}

export function forgetPasscode() {
  currentPasscodeHash = undefined;
}

export function clearEncryptedSession() {
  forgetPasscode();
  return PASSCODE_IDB_STORE.clear();
}

function legacySha256(plaintext: string) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${plaintext}${LEGACY_SALT}`));
}

export async function deriveKey(passcode: string, salt: BufferSource) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS,
    },
    material,
    256,
  );
}

async function loadSalt() {
  const stored = await PASSCODE_IDB_STORE.get<number[]>(KDF_SALT_KEY);
  return stored ? new Uint8Array(stored) : undefined;
}

async function upgradeLegacyKey(
  passcode: string, sessionJson: string, globalJson: string, sharedStateJson?: string,
) {
  const salt = crypto.getRandomValues(new Uint8Array(KDF_SALT_LENGTH));
  const key = await deriveKey(passcode, salt);
  await Promise.all([
    store('sessionEncrypted', await aesEncrypt(sessionJson, key)),
    store('globalEncrypted', await aesEncrypt(globalJson, key)),
    sharedStateJson ? store('sharedStateEncrypted', await aesEncrypt(sharedStateJson, key)) : undefined,
  ]);
  await PASSCODE_IDB_STORE.set(KDF_SALT_KEY, Array.from(salt));
  currentPasscodeHash = key;
}

function store(key: string, value: ArrayBuffer) {
  const asArray = Array.from(new Uint8Array(value));
  return PASSCODE_IDB_STORE.set(key, asArray);
}

export function hasEncryptedSession() {
  return PASSCODE_IDB_STORE.get('sessionEncrypted');
}

async function load(key: string) {
  const cached = await PASSCODE_IDB_STORE.get<number[]>(key);
  if (cached) {
    const asArrayBuffer = new Uint8Array(cached).buffer;
    return asArrayBuffer;
  }
  return undefined;
}

async function aesEncrypt(plaintext: string, pwHash: ArrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const alg = { name: 'AES-GCM', iv };
  const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['encrypt']);
  const ptUint8 = new TextEncoder().encode(plaintext);
  const ctBuffer = await crypto.subtle.encrypt(alg, key, ptUint8);
  const ct = new Uint8Array(ctBuffer);
  const result = new Uint8Array(IV_LENGTH + ct.length);
  result.set(iv, 0);
  result.set(ct, IV_LENGTH);
  return result.buffer;
}

async function aesDecrypt(data: ArrayBuffer, pwHash: ArrayBuffer) {
  const dataArray = new Uint8Array(data);
  const iv = dataArray.slice(0, IV_LENGTH);
  const alg = { name: 'AES-GCM', iv };
  const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['decrypt']);
  const ct = dataArray.slice(IV_LENGTH);
  const plainBuffer = await crypto.subtle.decrypt(alg, key, ct);

  return new TextDecoder().decode(plainBuffer);
}
