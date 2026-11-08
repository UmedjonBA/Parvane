import { del, get, set } from 'idb-keyval';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// PV-002: отказ записи второй пачки прежней перешифровки (`setMany` idb-keyval) — подменой модуля
const idbFail = vi.hoisted(() => ({ calls: 0, failAt: 0 }));
vi.mock('idb-keyval', async (importOriginal) => {
  const orig = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...orig,
    setMany: async (...args: Parameters<typeof orig.setMany>) => {
      idbFail.calls += 1;
      if (idbFail.failAt && idbFail.calls === idbFail.failAt) throw new Error('QuotaExceededError (тест)');
      return orig.setMany(...args);
    },
  };
});

import {
  clearSecureSession, clearTrustSecret, hasSecureProfile, hasStoragePin, isStorageUnlocked, loadSecureSession,
  loadTrustSecret, lockStorage, peekSecureRecord, saveSecureSession, saveTrustSecret, SecureE2eStorage,
  secureStorageInternals, setStoragePin, unlockStorageWithPin,
} from './secureStorage';
import { LegacyE2eStorage, legacyMigrationMark, legacyStorageInternals } from './secureStorageLegacy';

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
    // spec 035: ключ устройства профиля лежит под non-extractable ключом WebCrypto
    const id = await secureStorageInternals.profileIdOf(USER);
    const key = await get<CryptoKey>(id!, secureStorageInternals.keysStore);
    expect(key?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key!)).rejects.toThrow();
    const raw = [...(await secureStorageInternals.rawRecords(USER)).values()].join('');
    expect(raw).not.toContain(Buffer.from('sensitive state').toString('hex'));
  });

  it('peeks a record without creating the profile (diag hooks of e2e scenarios)', async () => {
    const ghost = 'peek-ghost@local';
    await expect(peekSecureRecord(ghost, 'trust-secret')).resolves.toBe(false);
    await expect(hasSecureProfile(ghost)).resolves.toBe(false);
    expect(await secureStorageInternals.profileIdOf(ghost)).toBeUndefined();

    await saveTrustSecret(USER, 'trust-1');
    await expect(hasSecureProfile(USER)).resolves.toBe(true);
    await expect(peekSecureRecord(USER, 'trust-secret')).resolves.toBe(true);
    await expect(peekSecureRecord(USER, 'session-token')).resolves.toBe(false);
    await SecureE2eStorage.clear(USER);
    await expect(peekSecureRecord(USER, 'trust-secret')).resolves.toBe(false);
    await expect(hasSecureProfile(USER)).resolves.toBe(false);
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
    const id = await secureStorageInternals.profileIdOf(USER);
    await del(id!, secureStorageInternals.keysStore);
    secureStorageInternals.forgetAll();

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

describe('secure E2E storage batches (perf A6)', () => {
  it('saves and deletes many records at once and lists a prefix by key range', async () => {
    const storage = await SecureE2eStorage.open('erin@local');
    await storage.saveRecords(Array.from({ length: 70 }, (_, i) => [`m:${String(i).padStart(3, '0')}`, { id: i }]));
    // Соседний префикс в диапазон не попадает
    await storage.saveRecord('mx:1', { id: 'other' });
    await storage.saveRecord('j:1', { id: 'journal' });
    const rows = await storage.loadRecordsByPrefix<{ id: number }>('m:');
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 70 }, (_, i) => i));
    await storage.deleteRecords(['m:000', 'm:001', 'm:069']);
    expect((await storage.loadRecordsByPrefix<{ id: number }>('m:')).length).toBe(67);
    expect(await storage.loadRecord('mx:1')).toEqual({ id: 'other' });
    await SecureE2eStorage.clearRecords('erin@local');
    expect(await storage.loadRecord('j:1')).toBeUndefined();
  });

  it('a new PIN shorter than 8 characters is rejected (WEB-15)', async () => {
    const user = 'gina@local';
    await SecureE2eStorage.open(user);
    await expect(setStoragePin(user, '1234')).rejects.toThrow(/too short/);
    await SecureE2eStorage.clear(user);
  });

  it('re-keys binary records together with JSON records when a PIN is set', async () => {
    const user = 'frank@local';
    const storage = await SecureE2eStorage.open(user);
    const bytes = new Uint8Array([1, 2, 3, 250, 251]);
    await storage.saveBytesRecord('v2-engine-bin', bytes);
    await storage.saveRecord('m:1', { id: 1 });
    await setStoragePin(user, '4321-pin-x');
    const pinned = await SecureE2eStorage.open(user);
    expect(await pinned.loadBytesRecord('v2-engine-bin')).toEqual(bytes);
    expect(await pinned.loadRecord('m:1')).toEqual({ id: 1 });
    await setStoragePin(user, '');
    await SecureE2eStorage.clear(user);
  });
});

describe('secure E2E storage: profiles created before spec 035', () => {
  // spec 035 T115: профиль до spec 035 разово переносится в `parvane-store-v3`; прежняя база не меняется, кроме
  // отметки «перенесено» (удаление — вручную по D2). Данные выдуманные.
  it('T115: a pre-035 profile without PIN moves to the new store on open, the old one only gets a mark', async () => {
    const user = 'legacy-profile@local';
    await SecureE2eStorage.clear(user);
    const old = await LegacyE2eStorage.open(user);
    await old.save({ engine: 'old' });
    await old.saveRecord('m:1', { id: 1, text: 'выдуманная строка' });
    await old.saveBytesRecord('v2-engine-bin', new Uint8Array([1, 2, 3]));
    await old.saveRecord('trust-secret', 'trust-old');
    await old.saveRecord('session-token', 'jwt-old');
    secureStorageInternals.forgetAll();
    const facade = await SecureE2eStorage.open(user);
    const id = await secureStorageInternals.profileIdOf(user);
    expect(id).toBeTruthy();
    expect(await facade.load()).toEqual({ engine: 'old' });
    expect(await facade.loadRecord('m:1')).toEqual({ id: 1, text: 'выдуманная строка' });
    expect(await facade.loadBytesRecord('v2-engine-bin')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await loadTrustSecret(user)).toBe('trust-old');
    expect(await loadSecureSession(user)).toBe('jwt-old');
    // Новое — в новом хранилище; прежние записи на месте, в прежнюю базу не пишется
    await facade.saveRecord('m:2', { id: 2 });
    const legacyAgain = await LegacyE2eStorage.open(user);
    expect(await legacyAgain.loadRecord('m:2')).toBeUndefined();
    expect(await legacyAgain.loadRecord('m:1')).toEqual({ id: 1, text: 'выдуманная строка' });
    expect(await legacyMigrationMark(user)).toMatchObject({ done: id, records: 5 });
    // Перезапуск — тот же новый профиль, повторного переноса нет
    secureStorageInternals.forgetAll();
    expect(await (await SecureE2eStorage.open(user)).loadRecord('m:2')).toEqual({ id: 2 });
    expect(await secureStorageInternals.profileIdOf(user)).toBe(id);
    await SecureE2eStorage.clear(user);
  });

  it('T115: a pre-035 profile under PIN moves after the PIN is entered and stays under the same PIN', async () => {
    const user = 'legacy-pin@local';
    const pin = '58204716';
    await SecureE2eStorage.clear(user);
    const L = legacyStorageInternals;
    const salt = crypto.getRandomValues(new Uint8Array(16)).buffer;
    const key = await L.derivePinKey(pin, salt);
    await set(L.pinId(user), {
      version: L.storageVersion,
      salt,
      check: await L.encryptWith(key, L.additionalData(user, 'pin-check'), L.pinCheckPlaintext),
    }, L.store);
    await set(L.stateId(user), await L.encryptWith(key, L.additionalData(user), { engine: 'pinned' }), L.store);
    await set(L.recordId(user, 'm:1'), await L.encryptWith(key, L.additionalData(user, 'm:1'), { id: 1 }), L.store);
    secureStorageInternals.forgetAll();
    expect(await hasStoragePin(user)).toBe(true);
    await expect(SecureE2eStorage.open(user)).rejects.toThrow();
    expect(await secureStorageInternals.profileIdOf(user)).toBeUndefined();
    expect(await unlockStorageWithPin(user, '00000000')).toBe(false);
    expect(await unlockStorageWithPin(user, pin)).toBe(true);
    expect(await secureStorageInternals.profileIdOf(user)).toBeTruthy();
    expect(await (await SecureE2eStorage.open(user)).load()).toEqual({ engine: 'pinned' });
    await secureStorageInternals.settled(user);
    expect(await secureStorageInternals.hasDeviceRecord(user)).toBe(false);
    // Перезапуск: новый профиль заперт тем же PIN
    secureStorageInternals.forgetAll();
    expect(await hasStoragePin(user)).toBe(true);
    await expect(SecureE2eStorage.open(user)).rejects.toThrow();
    expect(await unlockStorageWithPin(user, pin)).toBe(true);
    expect(await (await SecureE2eStorage.open(user)).loadRecord('m:1')).toEqual({ id: 1 });
    await setStoragePin(user, '');
    await SecureE2eStorage.clear(user);
  });

  it('T115: an interrupted move keeps the old profile working and the next start moves everything', async () => {
    const user = 'legacy-cut@local';
    const COUNT = 1200;
    await SecureE2eStorage.clear(user);
    const old = await LegacyE2eStorage.open(user);
    await old.save({ engine: 'cut' });
    await old.saveRecords(Array.from({ length: COUNT }, (_, i) => [`m:${i}`, { id: i }] as [string, unknown]));
    let big = 0;
    secureStorageInternals.failCommits((puts) => puts >= 500 && ++big === 2);
    secureStorageInternals.forgetAll();
    const facade = await SecureE2eStorage.open(user);
    secureStorageInternals.failCommits(undefined);
    // Перенос оборвался на второй пачке: указателя на новый профиль нет, прежний профиль читается целиком
    expect(await secureStorageInternals.profileIdOf(user)).toBeUndefined();
    expect(await facade.loadRecord(`m:${COUNT - 1}`)).toEqual({ id: COUNT - 1 });
    const pending = (await legacyMigrationMark(user))?.pending;
    expect(pending).toBeTruthy();
    secureStorageInternals.forgetAll();
    const moved = await SecureE2eStorage.open(user);
    expect(await secureStorageInternals.profileIdOf(user)).toBe(pending);
    expect(await moved.loadRecordsByPrefix('m:')).toHaveLength(COUNT);
    expect(await moved.load()).toEqual({ engine: 'cut' });
    await SecureE2eStorage.clear(user);
  });

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
    const raw = await secureStorageInternals.rawRecords(USER2);
    expect(raw.has('trust-secret')).toBe(true);
    expect(raw.get('trust-secret')).not.toContain(Buffer.from('trust-1').toString('hex'));
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

  it('puts the DEK under a PIN-derived key, removes the device key record and requires unlock', async () => {
    const storage = await SecureE2eStorage.open(USER3);
    await storage.save({ pickleKey: 'pin-secret' });
    await saveSecureSession(USER3, 'jwt-pin');
    expect(await hasStoragePin(USER3)).toBe(false);

    await setStoragePin(USER3, '1234-pin-x');
    expect(await hasStoragePin(USER3)).toBe(true);
    expect(isStorageUnlocked(USER3)).toBe(true);
    expect(await secureStorageInternals.hasDeviceRecord(USER3)).toBe(false);
    // Разблокировано в памяти: читается
    await expect((await SecureE2eStorage.open(USER3)).load()).resolves.toEqual({ pickleKey: 'pin-secret' });
    expect(await loadSecureSession(USER3)).toBe('jwt-pin');

    // «Перезагрузка»: без PIN хранилище закрыто
    await secureStorageInternals.settled(USER3);
    lockStorage(USER3);
    secureStorageInternals.forgetAll();
    expect(isStorageUnlocked(USER3)).toBe(false);
    await expect(SecureE2eStorage.open(USER3)).rejects.toThrow(/locked/);
    expect(await loadSecureSession(USER3)).toBeUndefined();
    expect(await unlockStorageWithPin(USER3, '0000')).toBe(false);
    expect(isStorageUnlocked(USER3)).toBe(false);
    expect(await unlockStorageWithPin(USER3, '1234-pin-x')).toBe(true);
    await expect((await SecureE2eStorage.open(USER3)).load()).resolves.toEqual({ pickleKey: 'pin-secret' });
    expect(await loadSecureSession(USER3)).toBe('jwt-pin');

    // Снятие PIN: обратно на IndexedDB-ключ, данные целы
    await setStoragePin(USER3, '');
    expect(await hasStoragePin(USER3)).toBe(false);
    expect(await secureStorageInternals.hasDeviceRecord(USER3)).toBe(true);
    await expect((await SecureE2eStorage.open(USER3)).load()).resolves.toEqual({ pickleKey: 'pin-secret' });
  });

  it('refuses to set a PIN while locked', async () => {
    const storage = await SecureE2eStorage.open(USER3);
    await storage.save({ x: 1 });
    await setStoragePin(USER3, '9999-pin-x');
    lockStorage(USER3);
    await expect(setStoragePin(USER3, '1111-pin-x')).rejects.toThrow(/locked/);
  });
});

// ── spec 035 US3 (T037/T038/T042): DEK под обёрткой, PIN = смена обёртки, AAD по store_id ─────────────
// Хуки `secureStorageInternals` (forgetAll — «перезагрузка страницы», settled — дождаться фонового переноса
// поколения, failCommits — отказ записи пачки, rawRecords — значения на носителе) есть только у хранилища
// движка; на прежнем коде вызовы через `?.` ничего не делают, и тест проверяет то же поведение по сути.
type Hooks = {
  forgetAll?: () => void;
  settled?: (user: string) => Promise<void>;
  failCommits?: (pred?: (puts: number, deletes: number) => boolean) => void;
  rawRecords?: (user: string) => Promise<Map<string, string>>;
};
const hooks = secureStorageInternals as unknown as Hooks;

// «Перезагрузка»: в памяти ничего не остаётся, хранилище открывается заново с диска
function restart(user: string) {
  lockStorage(user);
  hooks.forgetAll?.();
}

async function settle(user: string) {
  await hooks.settled?.(user);
}

describe('spec 035 PV-001: запись после смены PIN переживает перезапуск', () => {
  const USER4 = 'pv001@local';
  beforeEach(async () => {
    hooks.failCommits?.(undefined);
    await SecureE2eStorage.clear(USER4);
  });

  it('установка PIN: запись живого экземпляра читается после перезапуска PIN-ом', async () => {
    const s = await SecureE2eStorage.open(USER4);
    await s.saveRecord('before', { v: 0 });
    await setStoragePin(USER4, 'longpin123');
    await s.saveRecord('after', { v: 1 });
    await s.saveBytesRecord('bin-after', new Uint8Array([7, 8, 9]));
    await settle(USER4);
    restart(USER4);
    expect(await unlockStorageWithPin(USER4, 'longpin123')).toBe(true);
    const reopened = await SecureE2eStorage.open(USER4);
    expect(await reopened.loadRecord('after')).toEqual({ v: 1 });
    expect(await reopened.loadRecord('before')).toEqual({ v: 0 });
    expect(await reopened.loadBytesRecord('bin-after')).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('снятие PIN: запись живого экземпляра читается после перезапуска без PIN', async () => {
    const s = await SecureE2eStorage.open(USER4);
    await setStoragePin(USER4, 'longpin123');
    await settle(USER4);
    await s.saveRecord('pinned', { v: 2 });
    await setStoragePin(USER4, '');
    await s.saveRecord('after', { v: 3 });
    await settle(USER4);
    restart(USER4);
    expect(await hasStoragePin(USER4)).toBe(false);
    const reopened = await SecureE2eStorage.open(USER4);
    expect(await reopened.loadRecord('after')).toEqual({ v: 3 });
    expect(await reopened.loadRecord('pinned')).toEqual({ v: 2 });
  });
});

describe('spec 035 PV-002: отказ записи посреди смены PIN не теряет данных', () => {
  const USER5 = 'pv002@local';
  beforeEach(async () => {
    hooks.failCommits?.(undefined);
    await SecureE2eStorage.clear(USER5);
  });

  it('вторая пачка (> 512 записей) не записалась → прежний или новый PIN читает ВСЕ записи', async () => {
    const s = await SecureE2eStorage.open(USER5);
    await s.save({ engine: 'state-marker' });
    const N = 1200;
    await s.saveRecords(Array.from({ length: N }, (_, i) => [`m:${String(i).padStart(5, '0')}`, { id: i }]));

    // Отказ второй большой пачки: прежний код — второй `setMany` перешифровки, движок — вторая пачка переноса
    idbFail.calls = 0;
    idbFail.failAt = 2;
    let bigBatches = 0;
    hooks.failCommits?.((puts) => {
      if (puts < 100) return false;
      bigBatches += 1;
      return bigBatches === 2;
    });
    try {
      await setStoragePin(USER5, 'longpin123').catch(() => undefined);
      await settle(USER5);
    } finally {
      idbFail.failAt = 0;
      hooks.failCommits?.(undefined);
    }

    restart(USER5);
    if (await hasStoragePin(USER5)) {
      expect(await unlockStorageWithPin(USER5, 'longpin123')).toBe(true);
    }
    const opened = await SecureE2eStorage.open(USER5);
    expect(await opened.load()).toEqual({ engine: 'state-marker' });
    const rows = await opened.loadRecordsByPrefix<{ id: number }>('m:');
    expect(rows.length).toBe(N);
  }, 60_000);
});

describe('spec 035 T042: AAD по store_id, PIN — без перешифровки записей', () => {
  it('смена ника не перешифровывает записи', async () => {
    const from = 'nick-old@local';
    const to = 'nick-new@local';
    await SecureE2eStorage.clear(from);
    await SecureE2eStorage.clear(to);
    const s = await SecureE2eStorage.open(from);
    await s.save({ engine: 1 });
    await s.saveRecord('m:1', { id: 1 });
    await s.saveRecord('drafts', { a: 'b' });
    const module = await import('./secureStorage') as Record<string, unknown>;
    const rename = (module.renameStorageUser || module.migrateStorageUser) as (a: string, b: string) => Promise<void>;
    const raw = async (user: string) => {
      if (hooks.rawRecords) return hooks.rawRecords(user);
      // прежний формат: шифртекст именованных записей
      const out = new Map<string, string>();
      for (const name of ['m:1', 'drafts']) {
        const rec = await get<{ ciphertext: ArrayBuffer }>(secureStorageInternals.recordId(user, name),
          secureStorageInternals.store);
        if (rec) out.set(name, Buffer.from(rec.ciphertext).toString('hex'));
      }
      return out;
    };
    const before = await raw(from);
    expect(before.size).toBeGreaterThanOrEqual(2);
    await rename(from, to);
    const after = await raw(to);
    expect(after).toEqual(before);
    const moved = await SecureE2eStorage.open(to);
    expect(await moved.loadRecord('m:1')).toEqual({ id: 1 });
    expect(await moved.load()).toEqual({ engine: 1 });
    await SecureE2eStorage.clear(to);
  });

  it('смена PIN при 20 000 записях ≤ 1 с (SC-004)', async () => {
    const user = 'sc004@local';
    await SecureE2eStorage.clear(user);
    const s = await SecureE2eStorage.open(user);
    await s.saveRecords(Array.from({ length: 20_000 }, (_, i) => [`m:${i}`, { id: i, text: 'выдуманный текст' }]));
    const started = performance.now();
    await setStoragePin(user, 'longpin123');
    const took = performance.now() - started;
    await settle(user);
    expect(took).toBeLessThanOrEqual(1000);
    restart(user);
    expect(await unlockStorageWithPin(user, 'longpin123')).toBe(true);
    expect((await (await SecureE2eStorage.open(user)).loadRecordsByPrefix('m:')).length).toBe(20_000);
    await SecureE2eStorage.clear(user);
  }, 120_000);
});
