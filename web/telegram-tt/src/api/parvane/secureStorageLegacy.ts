// spec 035 T115: прежнее хранилище web — IndexedDB `parvane-e2e-v2` (ключ в экземпляре, PIN перешифровкой всех
// записей — находки PV-001/PV-002). Новые профили сюда не попадают: их ведёт хранилище движка (`secureStorage.ts`).
// Профиль, созданный до spec 035, при первом открытии (с PIN — после ввода PIN) разово переносится в
// `parvane-store-v3` (`secureStorage.ts migrateLegacyIn`): этот модуль только читает его записи и ставит отметку
// «перенесено»; записей прежнего профиля он больше не пишет и не перешифровывает. Удаление прежней базы и модуля —
// вручную по решению D2 (T149).
import {
  createStore, del, delMany, get, promisifyRequest, set, setMany,
} from 'idb-keyval';

const STORAGE_VERSION = 2;
const STORAGE = createStore('parvane-e2e-v2', 'secure-state');

// Запись в IndexedDB, которая не завершается, молча останавливает всё, что стоит
// за ней в очередях (состояние E2E, кэш истории, журнал исходящих): после
// перезагрузки на диске оказывается устаревшее состояние. Долгую запись называем
// в журнале — вместе с числом записей, идущих одновременно
const SLOW_WRITE_MS = 3000;
// Сколько записей шифровать/расшифровывать параллельно при чтении и записи
// пачкой (perf A3/A6)
const CRYPTO_BATCH = 64;
// Сколько записей класть одной транзакцией IndexedDB (perf A6): перенос
// 20 000 строк истории при привязке шёл 20 000 транзакциями
const WRITE_BATCH = 512;
let writesInFlight = 0;

async function timedWrite(name: string, bytes: number, write: () => Promise<void>) {
  const started = Date.now();
  writesInFlight += 1;
  const watchdog = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn(`[parvane] хранилище: запись «${name}» (${bytes} байт) идёт дольше ${SLOW_WRITE_MS} мс,`
      + ` одновременно записей: ${writesInFlight}`);
  }, SLOW_WRITE_MS);
  try {
    await write();
  } finally {
    clearTimeout(watchdog);
    writesInFlight -= 1;
    const took = Date.now() - started;
    if (took >= SLOW_WRITE_MS) {
      // eslint-disable-next-line no-console
      console.warn(`[parvane] хранилище: запись «${name}» заняла ${took} мс`);
    }
  }
}
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

// ВАЖНО: для записи состояния AAD остаётся ПРЕЖНИМ (без суффикса) — иначе
// сохранённое до этого состояние всех пользователей перестаёт расшифровываться
// (OperationError → «E2E недоступен»). Суффикс — только у именованных записей
function additionalData(user: string, record = 'state') {
  const base = `parvane-e2e-storage:${STORAGE_VERSION}:${user}`;
  return encoder.encode(record === 'state' ? base : `${base}:${record}`).buffer;
}

function recordId(user: string, name: string) {
  return `rec:${user}:${name}`;
}

// Диапазон ключей IndexedDB с данным префиксом (perf A6): вместо перебора всех
// ключей хранилища — выборка по индексу первичного ключа
function prefixRange(fullPrefix: string) {
  return IDBKeyRange.bound(fullPrefix, `${fullPrefix}\uffff`);
}

async function keysByPrefix(fullPrefix: string): Promise<string[]> {
  return STORAGE('readonly', (store) => promisifyRequest(
    store.getAllKeys(prefixRange(fullPrefix)),
  )) as Promise<string[]>;
}

async function entriesByPrefix<T>(fullPrefix: string): Promise<{ keys: string[]; values: T[] }> {
  return STORAGE('readonly', async (store) => {
    const range = prefixRange(fullPrefix);
    const [found, values] = await Promise.all([
      promisifyRequest(store.getAllKeys(range)),
      promisifyRequest(store.getAll(range)),
    ]);
    return { keys: found as string[], values: values as T[] };
  });
}

/** Пачками по `size`, каждая — параллельно. */
async function mapInBatches<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = await Promise.all(items.slice(start, start + size).map((item, offset) => fn(item, start + offset)));
    out.push(...batch);
  }
  return out;
}

async function generateProtectionKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export class LegacyE2eStorage {
  private constructor(
    private readonly user: string,
    private readonly protectionKey: CryptoKey,
  ) {}

  static async open(user: string) {
    const encrypted = await get<EncryptedRecord>(stateId(user), STORAGE);
    if (await get<PinRecord>(pinId(user), STORAGE)) {
      // P-39: хранилище под PIN — ключ только из памяти после unlockStorageWithPin
      const unlocked = unlockedKeys.get(user);
      if (!unlocked) throw new Error('E2E storage is protected by a PIN and is locked.');
      return new LegacyE2eStorage(user, unlocked);
    }
    let protectionKey = await get<CryptoKey>(keyId(user), STORAGE);
    if (encrypted && !protectionKey) {
      throw new Error('Encrypted E2E state exists, but its non-extractable protection key is missing.');
    }
    if (!protectionKey) {
      protectionKey = await generateProtectionKey();
      await set(keyId(user), protectionKey, STORAGE);
    }
    return new LegacyE2eStorage(user, protectionKey);
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
    await this.saveEncrypted(stateId(this.user), 'state', value);
  }

  // Именованные записи под тем же non-extractable ключом (журнал исходящих,
  // черновики): раньше они лежали в localStorage открытым текстом
  async saveRecord(name: string, value: unknown) {
    await this.saveEncrypted(recordId(this.user, name), name, value);
  }

  async loadRecord<T>(name: string): Promise<T | undefined> {
    const record = await get<EncryptedRecord>(recordId(this.user, name), STORAGE);
    if (!record || record.version !== STORAGE_VERSION) return undefined;
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv, additionalData: additionalData(this.user, name) },
        this.protectionKey,
        record.ciphertext,
      );
      return JSON.parse(decoder.decode(plaintext)) as T;
    } catch {
      return undefined;
    }
  }

  private async encryptNamed(name: string, plain: ArrayBuffer): Promise<EncryptedRecord> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(this.user, name) },
      this.protectionKey,
      plain,
    );
    return { version: STORAGE_VERSION, iv: iv.buffer, ciphertext };
  }

  private async saveEncrypted(id: string, name: string, value: unknown) {
    const record = await this.encryptNamed(name, encoder.encode(JSON.stringify(value)).buffer);
    await timedWrite(name, record.ciphertext.byteLength, () => set(id, record, STORAGE));
  }

  // Несколько именованных записей (пачка кэша истории): шифрование —
  // параллельно по CRYPTO_BATCH, запись — одной транзакцией на WRITE_BATCH
  // записей вместо транзакции на каждую (perf A6)
  async saveRecords(entries: [name: string, value: unknown][]) {
    if (!entries.length) return;
    const encrypted = await mapInBatches(entries, CRYPTO_BATCH, async ([name, value]) => [
      recordId(this.user, name),
      await this.encryptNamed(name, encoder.encode(JSON.stringify(value)).buffer),
    ] as [string, EncryptedRecord]);
    for (let start = 0; start < encrypted.length; start += WRITE_BATCH) {
      const batch = encrypted.slice(start, start + WRITE_BATCH);
      const bytes = batch.reduce((sum, [, record]) => sum + record.ciphertext.byteLength, 0);
      await timedWrite(`${entries[start][0]} (+${batch.length - 1})`, bytes, () => setMany(batch, STORAGE));
    }
  }

  async deleteRecords(names: string[]) {
    if (!names.length) return;
    await delMany(names.map((name) => recordId(this.user, name)), STORAGE);
  }

  // Все записи с префиксом имени (кэш истории `m:<uuid>`): ключи и значения
  // диапазоном одной транзакции, расшифровка — параллельно по CRYPTO_BATCH
  async loadRecordsByPrefix<T>(prefix: string): Promise<T[]> {
    const { keys: allKeys, values: records } = await entriesByPrefix<EncryptedRecord>(recordId(this.user, prefix));
    if (!allKeys.length) return [];
    const nameOffset = recordId(this.user, '').length;
    const decrypted = await mapInBatches(records, CRYPTO_BATCH, async (record, index) => {
      if (!record || record.version !== STORAGE_VERSION) return undefined;
      const name = allKeys[index].slice(nameOffset);
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: record.iv, additionalData: additionalData(this.user, name) },
          this.protectionKey,
          record.ciphertext,
        );
        return JSON.parse(decoder.decode(plaintext)) as T;
      } catch {
        // повреждённая запись — пропускаем
        return undefined;
      }
    });
    return decrypted.filter((value): value is Awaited<T> => value !== undefined);
  }

  // Двоичная запись (архив пака): шифруем байты как есть, без JSON — иначе
  // ArrayBuffer не сериализуется, а base64 раздувал бы 20-МБ пак на треть
  async saveBytesRecord(name: string, bytes: Uint8Array) {
    const plain = new Uint8Array(bytes.length);
    plain.set(bytes);
    const record = await this.encryptNamed(name, plain.buffer);
    await timedWrite(name, record.ciphertext.byteLength, () => set(recordId(this.user, name), record, STORAGE));
  }

  async loadBytesRecord(name: string): Promise<Uint8Array | undefined> {
    const record = await get<EncryptedRecord>(recordId(this.user, name), STORAGE);
    if (!record || record.version !== STORAGE_VERSION) return undefined;
    try {
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv, additionalData: additionalData(this.user, name) },
        this.protectionKey,
        record.ciphertext,
      ));
    } catch {
      return undefined;
    }
  }

  async deleteRecord(name: string) {
    await del(recordId(this.user, name), STORAGE);
  }

  static async clear(user: string) {
    unlockedKeys.delete(user);
    await Promise.all([
      del(stateId(user), STORAGE),
      del(keyId(user), STORAGE),
      del(pinId(user), STORAGE),
      del(`migrated:${user}`, STORAGE),
      LegacyE2eStorage.clearRecords(user),
    ]);
  }

  static async clearRecords(user: string) {
    const userKeys = await keysByPrefix(recordId(user, ''));
    if (userKeys.length) await delMany(userKeys, STORAGE);
  }
}

// ── P-39: опциональный PIN хранилища ────────────────────────────────────────
// Без PIN защитный ключ — non-extractable AES-GCM в IndexedDB рядом с
// шифртекстом: от XSS/расширения в этом origin он не спасает. С PIN ключ
// выводится PBKDF2-SHA256 (310k итераций) из PIN + соль и живёт только в
// памяти вкладки после разблокировки; в IndexedDB остаётся лишь соль и
// проверочная запись. Ключ из IndexedDB при этом удаляется.
const PIN_ITERATIONS = 310_000;
// Новый PIN — не короче: копию профиля перебирают офлайн, и 4 символа × PBKDF2 — часы на видеокарте (WEB-15).
// Прежние короткие PIN по-прежнему открывают хранилище; сменить на короткий нельзя
const PIN_CHECK_PLAINTEXT = 'parvane-pin-check-v1';

type PinRecord = { version: number; salt: ArrayBuffer; check: EncryptedRecord };

function pinId(user: string) {
  return `pin:${user}`;
}

// Разблокированные PIN-ключи (на время жизни вкладки)
const unlockedKeys = new Map<string, CryptoKey>();

async function derivePinKey(pin: string, salt: ArrayBuffer) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin).buffer, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptWith(key: CryptoKey, aad: ArrayBuffer, value: unknown): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad }, key, encoder.encode(JSON.stringify(value)).buffer,
  );
  return { version: STORAGE_VERSION, iv: iv.buffer, ciphertext };
}

async function decryptWith<T>(
  key: CryptoKey, aad: ArrayBuffer, record: EncryptedRecord | undefined,
): Promise<T | undefined> {
  if (!record || record.version !== STORAGE_VERSION) return undefined;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: aad }, key, record.ciphertext,
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return undefined;
  }
}

// Ключ пользователя: разблокированный PIN-ключ, иначе IndexedDB-ключ
// (создаётся при первом обращении, как в LegacyE2eStorage.open)
async function resolveProtectionKey(user: string): Promise<CryptoKey | undefined> {
  const unlocked = unlockedKeys.get(user);
  if (unlocked) return unlocked;
  if (await get<PinRecord>(pinId(user), STORAGE)) return undefined; // нужен PIN
  let key = await get<CryptoKey>(keyId(user), STORAGE);
  if (!key) {
    key = await generateProtectionKey();
    await set(keyId(user), key, STORAGE);
  }
  return key;
}

// Есть ли у адреса профиль прежнего формата (ключ устройства, PIN или состояние)
export async function legacyProfileExists(user: string) {
  const [key, pin, state] = await Promise.all([
    get(keyId(user), STORAGE), get(pinId(user), STORAGE), get(stateId(user), STORAGE),
  ]);
  return Boolean(key || pin || state);
}

export async function legacyHasStoragePin(user: string) {
  return Boolean(await get<PinRecord>(pinId(user), STORAGE));
}

export function legacyIsStorageUnlocked(user: string) {
  return unlockedKeys.has(user);
}

// Разблокировать хранилище PIN-ом. false — PIN неверен
export async function legacyUnlockStorageWithPin(user: string, pin: string): Promise<boolean> {
  const record = await get<PinRecord>(pinId(user), STORAGE);
  if (!record) return true;
  const key = await derivePinKey(pin, record.salt);
  const check = await decryptWith<string>(key, additionalData(user, 'pin-check'), record.check);
  if (check !== PIN_CHECK_PLAINTEXT) return false;
  unlockedKeys.set(user, key);
  return true;
}

export function legacyLockStorage(user: string) {
  unlockedKeys.delete(user);
}

// Перешифровать все записи пользователя с ключа `from` на ключ `to`
// ── разовый перенос (T115) ─────────────────────────────────────────────────────────────────────────────────

/** Отметка переноса: `pending` — id профиля `parvane-store-v3`, в который идёт перенос (повтор после прерывания —
 * в тот же профиль, частичная копия перезаписывается); `done` — перенос сверен и переключён. */
export type LegacyMigrationMark = { pending?: string; done?: string; at?: number; records?: number };

function migrationId(user: string) {
  return `migrated:${user}`;
}

export async function legacyMigrationMark(user: string): Promise<LegacyMigrationMark | undefined> {
  return get<LegacyMigrationMark>(migrationId(user), STORAGE);
}

/** Отметка «перенесено» (единственная запись, которую перенос делает в прежней базе; данные не трогаются). */
export async function legacySetMigrationMark(user: string, mark: LegacyMigrationMark) {
  await set(migrationId(user), mark, STORAGE);
}

/** Всё прежнее хранилище адреса открытым текстом — для разового переноса. `undefined` — профиль под PIN и
 * не разблокирован. Запись, которая не открывается своим ключом, пропускается (её не открыл бы и прежний код). */
export async function legacyExportAll(user: string): Promise<
{ state?: Uint8Array; records: [name: string, bytes: Uint8Array][]; skipped: number } | undefined
> {
  const key = await resolveProtectionKey(user);
  if (!key) return undefined;
  const open = async (aad: ArrayBuffer, record: EncryptedRecord | undefined) => {
    if (!record || record.version !== STORAGE_VERSION) return undefined;
    try {
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv, additionalData: aad }, key, record.ciphertext,
      ));
    } catch {
      return undefined;
    }
  };
  const state = await open(additionalData(user), await get<EncryptedRecord>(stateId(user), STORAGE));
  const prefix = recordId(user, '');
  const { keys: userKeys, values } = await entriesByPrefix<EncryptedRecord>(prefix);
  let skipped = 0;
  const opened = await mapInBatches(values, CRYPTO_BATCH, async (record, index) => {
    const name = userKeys[index].slice(prefix.length);
    const bytes = await open(additionalData(user, name), record);
    if (!bytes) skipped += 1;
    return bytes ? [name, bytes] as [string, Uint8Array] : undefined;
  });
  return {
    state,
    records: opened.filter((entry): entry is [string, Uint8Array] => entry !== undefined),
    skipped,
  };
}

async function saveSecret(user: string, name: string, value: string) {
  const key = await resolveProtectionKey(user);
  if (!key) throw new Error('Storage is locked.');
  await set(recordId(user, name), await encryptWith(key, additionalData(user, name), value), STORAGE);
}

async function loadSecret(user: string, name: string): Promise<string | undefined> {
  const key = await resolveProtectionKey(user);
  if (!key) return undefined;
  const record = await get<EncryptedRecord>(recordId(user, name), STORAGE);
  const value = await decryptWith<string>(key, additionalData(user, name), record);
  return typeof value === 'string' && value ? value : undefined;
}

export async function legacySaveTrustSecret(user: string, secret: string) {
  await saveSecret(user, 'trust-secret', secret);
}

export async function legacyLoadTrustSecret(user: string) {
  return loadSecret(user, 'trust-secret');
}

export async function legacyClearTrustSecret(user: string) {
  await del(recordId(user, 'trust-secret'), STORAGE);
}

export async function legacySaveSecureSession(user: string, token: string) {
  await saveSecret(user, 'session-token', token);
}

export async function legacyLoadSecureSession(user: string) {
  return loadSecret(user, 'session-token');
}

export async function legacyClearSecureSession(user: string) {
  await del(recordId(user, 'session-token'), STORAGE);
}

export const legacyStorageInternals = {
  store: STORAGE,
  // Тесты: профиль под PIN в прежнем формате (как его оставляла прежняя установка PIN)
  derivePinKey,
  encryptWith,
  pinCheckPlaintext: PIN_CHECK_PLAINTEXT,
  storageVersion: STORAGE_VERSION,
  keyId,
  stateId,
  pinId,
  recordId,
  additionalData,
};
