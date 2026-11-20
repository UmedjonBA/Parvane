import { beforeEach, describe, expect, it } from 'vitest';

import {
  enrollStorageBiometric, isStorageUnlocked, lockStorage, readStorageBiometric, removeStorageBiometric,
  SecureE2eStorage, secureStorageInternals, setStoragePin, unlockStorageWithBiometric, unlockStorageWithPin,
} from './secureStorage';
import {
  decodeBiometricRecord, encodeBiometricRecord, openWithPrf, sealWithPrf,
} from './storagePrfWrap';
import { createPrfCredential, evaluatePrf } from './storageWebAuthn';

// Вход по отпечатку: KEK обёртки PIN под секретом PRF аутентификатора. Секреты и PIN — выдуманные
const USER = 'bio-vera@local';
const PIN = '4821';
const PRF = new Uint8Array(32).fill(7);
const OTHER_PRF = new Uint8Array(32).fill(9);
const CREDENTIAL = { credentialId: new Uint8Array([1, 2, 3, 4]), prfSalt: new Uint8Array(32).fill(5), prf: PRF };
const PIN_ITERATIONS = 310_000;

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function derivePinKek(pin: string, saltHex: string) {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITERATIONS,
    }, material, 256,
  ));
}

async function reloadLocked() {
  await secureStorageInternals.settled(USER);
  lockStorage(USER);
  secureStorageInternals.forgetAll();
}

describe('заворачивание секретом PRF', () => {
  const binding = { profileId: 'p1', pinSalt: 'aa', credentialId: new Uint8Array([1]) };
  const secret = new Uint8Array(32).fill(3);

  it('открывается тем же секретом и меткой; другой секрет, профиль, PIN или ключ — нет', async () => {
    const sealed = await sealWithPrf(PRF, binding, secret);
    expect(toHex(sealed)).not.toContain(toHex(secret));
    expect(await openWithPrf(PRF, binding, sealed)).toEqual(secret);
    expect(await openWithPrf(OTHER_PRF, binding, sealed)).toBeUndefined();
    expect(await openWithPrf(PRF, { ...binding, profileId: 'p2' }, sealed)).toBeUndefined();
    expect(await openWithPrf(PRF, { ...binding, pinSalt: 'bb' }, sealed)).toBeUndefined();
    expect(await openWithPrf(PRF, { ...binding, credentialId: new Uint8Array([2]) }, sealed)).toBeUndefined();
    expect(await openWithPrf(PRF, binding, sealed.subarray(0, 8))).toBeUndefined();
  });

  it('запись переживает кодирование; испорченная не читается', () => {
    const record = {
      credentialId: new Uint8Array([9, 8]), prfSalt: new Uint8Array([1]), pinSalt: 'cc', sealed: new Uint8Array([4]),
    };
    expect(decodeBiometricRecord(encodeBiometricRecord(record))).toEqual(record);
    expect(decodeBiometricRecord(new TextEncoder().encode('{"v":1}'))).toBeUndefined();
    expect(decodeBiometricRecord(new TextEncoder().encode('not json'))).toBeUndefined();
  });
});

describe('хранилище: вход по отпечатку', () => {
  beforeEach(async () => {
    await SecureE2eStorage.clear(USER);
    const storage = await SecureE2eStorage.open(USER);
    await storage.save({ note: 'invented-secret' });
    await setStoragePin(USER, PIN);
  });

  it('включается только верным PIN и не кладёт KEK на диск открыто', async () => {
    expect(await enrollStorageBiometric(USER, '0000', CREDENTIAL)).toBe(false);
    expect(await readStorageBiometric(USER)).toBeUndefined();

    expect(await enrollStorageBiometric(USER, PIN, CREDENTIAL)).toBe(true);
    expect(await readStorageBiometric(USER)).toEqual({
      credentialId: CREDENTIAL.credentialId, prfSalt: CREDENTIAL.prfSalt,
    });
    const raw = (await secureStorageInternals.biometricRecord(USER))!;
    const record = decodeBiometricRecord(raw)!;
    const kek = await derivePinKek(PIN, record.pinSalt);
    expect(toHex(raw)).not.toContain(toHex(kek));
    expect(new TextDecoder().decode(raw)).not.toContain(toHex(kek));
    expect(new TextDecoder().decode(raw)).not.toContain(toHex(PRF));
  });

  it('после «перезагрузки» открывает хранилище секретом аутентификатора; чужой секрет — нет', async () => {
    await enrollStorageBiometric(USER, PIN, CREDENTIAL);
    await reloadLocked();
    expect(isStorageUnlocked(USER)).toBe(false);

    expect(await unlockStorageWithBiometric(USER, OTHER_PRF)).toBe(false);
    expect(isStorageUnlocked(USER)).toBe(false);
    expect(await unlockStorageWithBiometric(USER, PRF)).toBe(true);
    expect(isStorageUnlocked(USER)).toBe(true);
    await expect((await SecureE2eStorage.open(USER)).load()).resolves.toEqual({ note: 'invented-secret' });

    // PIN по-прежнему работает
    await reloadLocked();
    expect(await unlockStorageWithPin(USER, PIN)).toBe(true);
  });

  it('смена и снятие PIN стирают запись; выключение — тоже', async () => {
    await enrollStorageBiometric(USER, PIN, CREDENTIAL);
    await setStoragePin(USER, '1379');
    expect(await secureStorageInternals.biometricRecord(USER)).toBeUndefined();
    await reloadLocked();
    expect(await unlockStorageWithBiometric(USER, PRF)).toBe(false);
    expect(await unlockStorageWithPin(USER, '1379')).toBe(true);

    expect(await enrollStorageBiometric(USER, '1379', CREDENTIAL)).toBe(true);
    await removeStorageBiometric(USER);
    expect(await readStorageBiometric(USER)).toBeUndefined();

    expect(await enrollStorageBiometric(USER, '1379', CREDENTIAL)).toBe(true);
    await setStoragePin(USER, '');
    expect(await secureStorageInternals.biometricRecord(USER)).toBeUndefined();
  });

  it('стирание профиля уносит запись', async () => {
    await enrollStorageBiometric(USER, PIN, CREDENTIAL);
    await SecureE2eStorage.clear(USER);
    expect(await secureStorageInternals.biometricRecord(USER)).toBeUndefined();
  });
});

describe('обращение к аутентификатору', () => {
  type Answer = { rawId?: ArrayBuffer; prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } } | Error;

  function fakeCredentials(created: Answer, got?: Answer) {
    const calls = { create: 0, get: 0 };
    const answer = (value: Answer | undefined) => {
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve({
        rawId: value?.rawId || new Uint8Array([7, 7]).buffer,
        getClientExtensionResults: () => ({ prf: value?.prf }),
      });
    };
    return {
      calls,
      api: {
        create: () => {
          calls.create += 1;
          return answer(created);
        },
        get: () => {
          calls.get += 1;
          return answer(got);
        },
      } as unknown as CredentialsContainer,
    };
  }

  function namedError(name: string) {
    const err = new Error(name);
    err.name = name;
    return err;
  }

  it('без PRF — «не поддерживается»; отмена — «отменено»', async () => {
    expect(await createPrfCredential('vera', fakeCredentials({ prf: { enabled: false } }).api)).toBe('unsupported');
    expect(await createPrfCredential('vera', fakeCredentials({}).api)).toBe('unsupported');
    expect(await createPrfCredential('vera', fakeCredentials(namedError('NotAllowedError')).api)).toBe('cancelled');
    expect(await evaluatePrf(new Uint8Array([1]), PRF, fakeCredentials({}, namedError('AbortError')).api))
      .toBe('cancelled');
    expect(await evaluatePrf(new Uint8Array([1]), PRF, fakeCredentials({}, { prf: {} }).api)).toBe('unsupported');
  });

  it('секрет при создании берётся сразу, иначе — входом тем же ключом', async () => {
    const secret = new Uint8Array(32).fill(1).buffer;
    const direct = fakeCredentials({ prf: { enabled: true, results: { first: secret } } });
    const made = await createPrfCredential('vera', direct.api);
    expect(typeof made === 'string' ? made : made.prf).toEqual(new Uint8Array(secret));
    expect(direct.calls.get).toBe(0);

    const later = fakeCredentials({ prf: { enabled: true } }, { prf: { results: { first: secret } } });
    const second = await createPrfCredential('vera', later.api);
    expect(typeof second === 'string' ? second : toHex(second.credentialId)).toBe('0707');
    expect(later.calls.get).toBe(1);
  });
});
