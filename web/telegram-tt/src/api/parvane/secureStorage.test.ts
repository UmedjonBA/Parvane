import { del, get } from 'idb-keyval';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearSecureSession, clearTrustSecret, hasStoragePin, isStorageUnlocked, loadSecureSession, loadTrustSecret,
  lockStorage, saveSecureSession, saveTrustSecret, SecureE2eStorage, secureStorageInternals, setStoragePin,
  unlockStorageWithPin,
} from './secureStorage';

const USER = 'secure-storage@local';

describe('secure E2E storage', () => {
  beforeEach(async () => {
    await SecureE2eStorage.clear(USER);
  });

  it('encrypts state with a non-extractable WebCrypto key', async () => {
    const storage = await SecureE2eStorage.open(USER);
    await storage.save({ pickleKey: 'unique-secret', plaintext: 'sensitive state' });

    await expect(storage.load()).resolves.toEqual({
      pickleKey: 'unique-secret', plaintext: 'sensitive state',
    });
    const key = await get<CryptoKey>(
      secureStorageInternals.keyId(USER),
      secureStorageInternals.store,
    );
    const record = await get<{ ciphertext: ArrayBuffer }>(
      secureStorageInternals.stateId(USER),
      secureStorageInternals.store,
    );
    expect(key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow();
    expect(new TextDecoder().decode(record?.ciphertext)).not.toContain('sensitive state');
  });

  it('binds ciphertext to the account identity', async () => {
    const storage = await SecureE2eStorage.open(USER);
    await storage.save({ value: 1 });

    const other = await SecureE2eStorage.open('other-secure-storage@local');
    expect(await other.load()).toBeUndefined();
    await SecureE2eStorage.clear('other-secure-storage@local');
  });

  it('fails closed when ciphertext outlives its protection key', async () => {
    const storage = await SecureE2eStorage.open(USER);
    await storage.save({ value: 'must not be reset silently' });
    await del(secureStorageInternals.keyId(USER), secureStorageInternals.store);

    await expect(SecureE2eStorage.open(USER)).rejects.toThrow('protection key is missing');
  });
});

describe('secure E2E storage records', () => {
  it('stores named records and lists them by prefix under the same key', async () => {
    const storage = await SecureE2eStorage.open('carol@local');
    await storage.saveRecord('journal', [{ id: 'j1' }]);
    await storage.saveRecord('m:u1', { id: 'u1', ts: 1 });
    await storage.saveRecord('m:u2', { id: 'u2', ts: 2 });
    expect(await storage.loadRecord<unknown[]>('journal')).toEqual([{ id: 'j1' }]);
    const history = await storage.loadRecordsByPrefix<{ id: string }>('m:');
    expect(history.map((r) => r.id).sort()).toEqual(['u1', 'u2']);
    await storage.deleteRecord('m:u1');
    expect((await storage.loadRecordsByPrefix<{ id: string }>('m:')).map((r) => r.id)).toEqual(['u2']);
    // Записи другого пользователя не видны и не читаются его ключом
    const other = await SecureE2eStorage.open('dave@local');
    expect(await other.loadRecordsByPrefix('m:')).toEqual([]);
    await SecureE2eStorage.clearRecords('carol@local');
    expect(await storage.loadRecord('journal')).toBeUndefined();
    expect(await storage.loadRecordsByPrefix('m:')).toEqual([]);
  });
});

describe('secure E2E storage compatibility', () => {
  it('keeps the legacy AAD for the state record so old profiles still decrypt', () => {
    const decoder = new TextDecoder();
    const state = decoder.decode(secureStorageInternals.additionalData('erin@local'));
    expect(state).toBe('parvane-e2e-storage:2:erin@local');
    const named = decoder.decode(secureStorageInternals.additionalData('erin@local', 'journal'));
    expect(named).toBe('parvane-e2e-storage:2:erin@local:journal');
  });
});

// P-14/P-39: секрет доверия и JWT сессии — в шифрованном хранилище; пароль не хранится
describe('secure session secrets', () => {
  const USER2 = 'secure-secrets@local';
  beforeEach(async () => {
    await SecureE2eStorage.clear(USER2);
  });

  it('stores the trust secret and session token encrypted, never a password', async () => {
    await saveTrustSecret(USER2, 'trust-1');
    await saveSecureSession(USER2, 'jwt-1');
    expect(await loadTrustSecret(USER2)).toBe('trust-1');
    expect(await loadSecureSession(USER2)).toBe('jwt-1');
    const record = await get<{ ciphertext: ArrayBuffer }>(
      secureStorageInternals.recordId(USER2, 'trust-secret'), secureStorageInternals.store,
    );
    expect(new TextDecoder().decode(record?.ciphertext)).not.toContain('trust-1');
    await clearTrustSecret(USER2);
    await clearSecureSession(USER2);
    expect(await loadTrustSecret(USER2)).toBeUndefined();
    expect(await loadSecureSession(USER2)).toBeUndefined();
    const source = await import('./secureStorage');
    expect('saveSecureCredential' in source).toBe(false);
  });
});

describe('P-39: optional storage PIN', () => {
  const USER3 = 'secure-pin@local';
  beforeEach(async () => {
    await SecureE2eStorage.clear(USER3);
  });

  it('re-keys state under a PIN-derived key, removes the IndexedDB key and requires unlock', async () => {
    const storage = await SecureE2eStorage.open(USER3);
    await storage.save({ pickleKey: 'pin-secret' });
    await saveSecureSession(USER3, 'jwt-pin');
    expect(await hasStoragePin(USER3)).toBe(false);

    await setStoragePin(USER3, '1234');
    expect(await hasStoragePin(USER3)).toBe(true);
    expect(isStorageUnlocked(USER3)).toBe(true);
    expect(await get(secureStorageInternals.keyId(USER3), secureStorageInternals.store)).toBeUndefined();
    // Разблокировано в памяти: читается
    await expect((await SecureE2eStorage.open(USER3)).load()).resolves.toEqual({ pickleKey: 'pin-secret' });
    expect(await loadSecureSession(USER3)).toBe('jwt-pin');

    // «Перезагрузка»: без PIN хранилище закрыто
    lockStorage(USER3);
    expect(isStorageUnlocked(USER3)).toBe(false);
    await expect(SecureE2eStorage.open(USER3)).rejects.toThrow(/locked/);
    expect(await loadSecureSession(USER3)).toBeUndefined();
    expect(await unlockStorageWithPin(USER3, '0000')).toBe(false);
    expect(isStorageUnlocked(USER3)).toBe(false);
    expect(await unlockStorageWithPin(USER3, '1234')).toBe(true);
    await expect((await SecureE2eStorage.open(USER3)).load()).resolves.toEqual({ pickleKey: 'pin-secret' });
    expect(await loadSecureSession(USER3)).toBe('jwt-pin');

    // Снятие PIN: обратно на IndexedDB-ключ, данные целы
    await setStoragePin(USER3, '');
    expect(await hasStoragePin(USER3)).toBe(false);
    expect(await get(secureStorageInternals.keyId(USER3), secureStorageInternals.store)).toBeDefined();
    await expect((await SecureE2eStorage.open(USER3)).load()).resolves.toEqual({ pickleKey: 'pin-secret' });
  });

  it('refuses to set a PIN while locked', async () => {
    const storage = await SecureE2eStorage.open(USER3);
    await storage.save({ x: 1 });
    await setStoragePin(USER3, '9999');
    lockStorage(USER3);
    await expect(setStoragePin(USER3, '1111')).rejects.toThrow(/locked/);
  });
});
