import { del, get } from 'idb-keyval';
import { beforeEach, describe, expect, it } from 'vitest';

import { SecureE2eStorage, secureStorageInternals } from './secureStorage';

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
