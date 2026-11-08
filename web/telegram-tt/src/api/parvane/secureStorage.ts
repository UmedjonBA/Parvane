// spec 035 US3 (contracts/storage.md, FR-020…FR-028): шифрованное хранилище web — фасад над хранилищем движка
// (`PvStore` WASM, `backend/protocol/src/store.rs`) и адаптером IndexedDB `v2/storeIdb.ts`.
//
// - Ключ записи на носителе — `g<поколение>/<вид>/<имя>`, значение — `Stored` под DEK поколения; AAD — по
//   `store_id` профиля, не по адресу: смена ника — только указатель «адрес → профиль» (FR-022, T047).
// - DEK живёт в памяти движка. Экземпляр `SecureE2eStorage` ключа не держит (PV-001): каждая операция идёт
//   через текущее состояние профиля.
// - PIN: установка/смена/снятие — смена обёртки DEK одной транзакцией корня (PV-002, FR-021); после установки
//   — фоном перенос поколения (новый DEK, P1–P6) с продолжением после перезапуска (T044).
// - Ключ устройства (решение T043): 32 случайных байта профиля лежат в IndexedDB под non-extractable ключом
//   WebCrypto (`parvane-store-v3-keys`). Движку отдаются сырые байты, поэтому он может обернуть ими DEK нового
//   поколения так же, как ядро desktop/android; неизвлекаемым остаётся ключ, без которого эти байты не открыть.
//   При установке PIN запись `device` удаляется в той же транзакции, что и обёртка устройства в корне.
// - KEK обёртки PIN выводит WebCrypto (PBKDF2-SHA256, 310 000 итераций — тот же результат, что `store::pin_kek`).
// - Вкладки (FR-027): каждая запись сверяет корень с носителем под общим замком (Web Locks); смена обёртки,
//   блокировка и смена поколения рассылаются `tabSignal` (T045).
// - Профили, созданные до spec 035 (`parvane-e2e-v2`), ведёт прежний модуль `secureStorageLegacy.ts` без
//   изменений до переноса T115.
import { createStore, del, get, set } from 'idb-keyval';

import type { PvStore } from '../../lib/parvane-protocol/parvane_protocol';
import type { StoreIdb } from './v2/storeIdb';
import type { StorageSignal } from './v2/tabSignal';

import { storeOpen } from '../../lib/parvane-protocol/parvane_protocol';
import { loadProtocol } from './v2/engine';
import { openStoreIdb, STORE_DB } from './v2/storeIdb';
import { createStorageSignal } from './v2/tabSignal';
import {
  legacyClearSecureSession, legacyClearTrustSecret, LegacyE2eStorage, legacyHasStoragePin, legacyIsStorageUnlocked,
  legacyLoadSecureSession, legacyLoadTrustSecret, legacyLockStorage, legacyMigrateStorageUser, legacyProfileExists,
  legacySaveSecureSession, legacySaveTrustSecret, legacySetStoragePin, legacyStorageInternals,
  legacyUnlockStorageWithPin,
} from './secureStorageLegacy';

// Новый PIN — не короче: копию профиля перебирают офлайн (WEB-15)
export const STORAGE_PIN_MIN_LENGTH = 8;
const PIN_ITERATIONS = 310_000;
// Записей в одной транзакции записи пачкой
const WRITE_BATCH = 512;
const SLOW_WRITE_MS = 3000;
// Ключ записи устройства в базе профиля (вне пространства ключей движка `root`, `g*/`)
const DEVICE_KEY = 'device';
const ROOT_KEY = 'root';
// Записи по имени: вид хранилища движка (data-model.md §2); прочее — `engine-core`
const KINDS = ['engine-core', 'history-row', 'outbox', 'draft-local', 'state-object', 'group-view'] as const;
const STATE_NAME = '__state';

const KEYS = createStore('parvane-store-v3-keys', 'keys');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toB64(bytes: Uint8Array) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromB64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function kindOf(name: string): string {
  if (name.startsWith('m:')) return 'history-row';
  if (name.startsWith('j:')) return 'outbox';
  if (name === 'drafts' || name === 'scheduled') return 'draft-local';
  if (name.startsWith('ls:')) return 'state-object';
  if (name.startsWith('gv:')) return 'group-view';
  return 'engine-core';
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(text: string) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function buf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// KEK обёртки PIN: PBKDF2-HMAC-SHA256(PIN UTF-8, соль, итерации, 32 байта) — WebCrypto
async function pinKek(pin: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey('raw', buf(encoder.encode(pin)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, material, 256,
  ));
}

function deviceAad(profile: string) {
  return buf(encoder.encode(`parvane/store/device/v1\0${profile}`));
}

type RootInfo = {
  activeGeneration: number;
  pendingGeneration: number;
  retiringGeneration: number;
  wraps: string[];
  pinSalt?: string;
  pinIterations?: number;
};

type JsBatch = { batchId: number; puts: { key: string; value: Uint8Array }[]; deletes: string[] };
type RotationStep =
  | { type: 'read'; readId: number; prefix: string; after: string; limit: number }
  | { type: 'write'; batch: JsBatch }
  | { type: 'continue' } | { type: 'done' } | { type: 'aborted'; errors: string[] };

export type StorageMigration = { active: boolean; point: number; startedAt: number; errors: string[] };

type Profile = {
  user: string;
  id: string;
  idb: StoreIdb;
  engine: PvStore;
  chain: Promise<unknown>;
  rotation?: Promise<void>;
  migration: StorageMigration;
  signal: ReturnType<typeof createStorageSignal>;
};

type Ctx = {
  tab: string;
  profiles: Map<string, Promise<Profile | undefined>>;
  resolved: Map<string, Profile>;
  legacy: Map<string, boolean>;
  dir?: Promise<StoreIdb>;
  failPred?: (puts: number, deletes: number) => boolean;
};

function newCtx(): Ctx {
  return {
    tab: hex(randomBytes(8)), profiles: new Map(), resolved: new Map(), legacy: new Map(),
  };
}

const DEFAULT_CTX = newCtx();
const migrationListeners = new Set<(user: string, state: StorageMigration) => void>();
const lockedListeners = new Set<(user: string) => void>();
const clearedListeners = new Set<(user: string) => void>();

function info(p: Profile): RootInfo {
  return JSON.parse(p.engine.rootInfo()) as RootInfo;
}

function directory(ctx: Ctx) {
  ctx.dir ||= openStoreIdb(STORE_DB);
  return ctx.dir;
}

async function profileIdOf(ctx: Ctx, user: string): Promise<string | undefined> {
  const dir = await directory(ctx);
  const [entry] = await dir.read({
    readId: '0', keys: [`profile/${user}`], prefix: '', after: '', limit: 0,
  });
  return entry ? decoder.decode(entry.value) : undefined;
}

async function readKey(idb: StoreIdb, key: string) {
  const [entry] = await idb.read({
    readId: '0', keys: [key], prefix: '', after: '', limit: 0,
  });
  return entry?.value;
}

async function nxKey(profile: string, create: boolean): Promise<CryptoKey | undefined> {
  let key = await get<CryptoKey>(profile, KEYS);
  if (!key && create) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await set(profile, key, KEYS);
  }
  return key;
}

async function sealDevice(profile: string, raw: Uint8Array) {
  const key = (await nxKey(profile, true))!;
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: deviceAad(profile) }, key, buf(raw),
  ));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function deviceKeyOf(p: Profile): Promise<Uint8Array> {
  const sealed = await readKey(p.idb, DEVICE_KEY);
  const key = await nxKey(p.id, false);
  if (!sealed || !key) {
    throw new Error('Encrypted E2E state exists, but its non-extractable protection key is missing.');
  }
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf(sealed.subarray(0, 12)), additionalData: deviceAad(p.id) }, key,
    buf(sealed.subarray(12)),
  ));
}

// Замок профиля: общий для вкладок (Web Locks), иначе — очередь вкладки
function exclusive<T>(p: Profile, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) {
    return locks.request(`parvane-store:${p.id}`, () => fn());
  }
  const run = p.chain.then(fn, fn);
  p.chain = run.catch(() => undefined);
  return run;
}

async function commit(ctx: Ctx, p: Profile, batch: JsBatch) {
  const started = Date.now();
  try {
    if (ctx.failPred?.(batch.puts.length, batch.deletes.length)) throw new Error('store_batch: отказ записи (тест)');
    await p.idb.commit({ batchId: String(batch.batchId), puts: batch.puts, deletes: batch.deletes });
  } catch (e) {
    p.engine.failed(batch.batchId, String(e));
    throw e;
  }
  p.engine.committed(batch.batchId);
  const took = Date.now() - started;
  if (took >= SLOW_WRITE_MS) {
    // eslint-disable-next-line no-console
    console.warn(`[parvane] хранилище: пачка из ${batch.puts.length} записей заняла ${took} мс`);
  }
}

// Ключ устройства открывает профиль без PIN — после блокировки или смены корня другой вкладкой
async function ensureReady(p: Profile) {
  if (p.engine.state() !== 'locked') return;
  if (!info(p).wraps.includes('device')) return;
  p.engine.storeUnlock(await deviceKeyOf(p), false);
}

// Корень на носителе сменила другая вкладка — принять до записи (FR-027)
async function syncRoot(ctx: Ctx, p: Profile) {
  const root = await readKey(p.idb, ROOT_KEY);
  if (!root) return;
  const mine = p.engine.rootBytes();
  if (mine.length === root.length && mine.every((b, i) => b === root[i])) return;
  const state = p.engine.refreshRoot(root);
  if (state === 'locked') {
    await ensureReady(p).catch(() => undefined);
    if (p.engine.state() === 'locked') lockedListeners.forEach((fn) => fn(p.user));
  }
}

function emitMigration(p: Profile) {
  migrationListeners.forEach((fn) => fn(p.user, { ...p.migration }));
}

function onSignal(ctx: Ctx, p: Profile, kind: StorageSignal) {
  if (kind === 'storage-locked') {
    if (info(p).wraps.includes('pin')) {
      p.engine.storeLock();
      lockedListeners.forEach((fn) => fn(p.user));
    }
    return;
  }
  void exclusive(p, () => syncRoot(ctx, p)).catch(() => undefined);
}

async function openProfile(ctx: Ctx, user: string, create: boolean): Promise<Profile | undefined> {
  let pending = ctx.profiles.get(user);
  if (!pending) {
    pending = loadProfile(ctx, user, create);
    ctx.profiles.set(user, pending);
    pending.then((p) => {
      if (p) ctx.resolved.set(user, p);
      else if (ctx.profiles.get(user) === pending) ctx.profiles.delete(user);
    }, () => {
      if (ctx.profiles.get(user) === pending) ctx.profiles.delete(user);
    });
  }
  const p = await pending;
  if (p || !create) return p;
  ctx.profiles.delete(user);
  return openProfile(ctx, user, create);
}

async function loadProfile(ctx: Ctx, user: string, create: boolean): Promise<Profile | undefined> {
  await loadProtocol();
  let id = await profileIdOf(ctx, user);
  if (!id && !create) return undefined;
  const isNew = !id;
  id ||= hex(randomBytes(16));
  const idb = await openStoreIdb(`${STORE_DB}-${id}`);
  const root = await readKey(idb, ROOT_KEY);
  if (!root && !create) return undefined;
  const engine = storeOpen(root || new Uint8Array(0));
  const p: Profile = {
    user,
    id,
    idb,
    engine,
    chain: Promise.resolve(),
    migration: {
      active: false, point: 0, startedAt: 0, errors: [],
    },
    signal: createStorageSignal(id, ctx.tab, (kind) => onSignal(ctx, p, kind)),
  };
  if (!root) {
    // Новый профиль: DEK поколения 1 под ключом устройства; корень и запись устройства — одной транзакцией
    const raw = randomBytes(32);
    const batch = engine.storeWrapDevice(raw) as JsBatch;
    batch.puts.push({ key: DEVICE_KEY, value: await sealDevice(id, raw) });
    raw.fill(0);
    await commit(ctx, p, batch);
  } else {
    await ensureReady(p);
  }
  if (isNew || !root) {
    const dir = await directory(ctx);
    await dir.commit({ batchId: '0', puts: [{ key: `profile/${user}`, value: encoder.encode(id) }], deletes: [] });
  }
  resumeRotation(ctx, p);
  return p;
}

function resumeRotation(ctx: Ctx, p: Profile) {
  if (p.engine.state() !== 'ready') return;
  const i = info(p);
  if (i.pendingGeneration || i.retiringGeneration) runRotation(ctx, p);
}

// ── перенос поколения (T044): фоном, шаг — под замком профиля; чтение и его пачка — в одном шаге ─────────
function runRotation(ctx: Ctx, p: Profile) {
  if (p.rotation) return p.rotation;
  p.migration = {
    active: true, point: p.engine.rotationPoint() || 1, startedAt: Date.now(), errors: [],
  };
  emitMigration(p);
  const step = () => exclusive(p, async (): Promise<boolean> => {
    for (;;) {
      if (p.engine.state() !== 'ready') return true;
      let action: RotationStep;
      try {
        action = p.engine.rotationNext() as RotationStep;
      } catch (e) {
        p.migration.errors = [String(e)];
        return true;
      }
      if (action.type === 'done') return true;
      if (action.type === 'aborted') {
        p.migration.errors = action.errors;
        return true;
      }
      if (action.type === 'continue') continue;
      if (action.type === 'read') {
        const entries = await p.idb.read({
          readId: String(action.readId), keys: [], prefix: action.prefix, after: action.after, limit: action.limit,
        });
        try {
          p.engine.rotationLoaded(action.readId, entries.map((e) => e.key), entries.map((e) => e.value));
        } catch {
          // ошибка расшифровки — движок уже перевёл перенос в откат; следующий шаг его запишет
        }
        continue;
      }
      const before = info(p).activeGeneration;
      const hasRoot = action.batch.puts.some((x) => x.key === ROOT_KEY);
      try {
        await commit(ctx, p, action.batch);
      } catch {
        // движку сообщено (`failed`): до переключения — откат, после — удаление повторится
      }
      if (hasRoot) {
        p.signal.post(info(p).activeGeneration !== before ? 'storage-generation-switched' : 'storage-wrap-changed');
      }
      return false;
    }
  });
  p.rotation = (async () => {
    for (;;) {
      const finished = await step();
      p.migration.point = p.engine.rotationPoint() || p.migration.point;
      emitMigration(p);
      if (finished) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  })().catch((e: unknown) => {
    p.migration.errors = [String(e)];
  }).finally(() => {
    p.rotation = undefined;
    p.migration.active = false;
    if (p.migration.errors.length) {
      // eslint-disable-next-line no-console
      console.warn(`[parvane] хранилище: смена ключа остановлена: ${p.migration.errors.slice(0, 3).join('; ')}`);
    }
    emitMigration(p);
  });
  return p.rotation;
}

// ── записи ───────────────────────────────────────────────────────────────────────────────────────────────
async function writeRecords(
  ctx: Ctx, p: Profile, puts: [name: string, bytes: Uint8Array][], deletes: string[] = [],
) {
  for (let start = 0; start < Math.max(puts.length, deletes.length); start += WRITE_BATCH) {
    const chunk = puts.slice(start, start + WRITE_BATCH);
    const dels = deletes.slice(start, start + WRITE_BATCH);
    await exclusive(p, async () => {
      await syncRoot(ctx, p);
      await ensureReady(p);
      if (p.engine.state() !== 'ready') throw new Error('Storage is locked.');
      const batch = p.engine.write(
        chunk.map(([name]) => kindOf(name)), chunk.map(([name]) => name), chunk.map(([, bytes]) => bytes),
        dels.map(kindOf), dels,
      ) as JsBatch;
      await commit(ctx, p, batch);
    });
  }
}

async function readValues(p: Profile, fn: () => Promise<Uint8Array | undefined>) {
  // Во время переноса поколения чтение — под замком (активное поколение может смениться)
  return p.rotation ? exclusive(p, fn) : fn();
}

async function readRecord(p: Profile, name: string): Promise<Uint8Array | undefined> {
  return readValues(p, async () => {
    await ensureReady(p);
    const g = info(p).activeGeneration;
    const key = `g${g}/${kindOf(name)}/${name}`;
    const value = await readKey(p.idb, key);
    if (!value) return undefined;
    try {
      return p.engine.open(key, value);
    } catch {
      return undefined;
    }
  });
}

async function readPrefix(p: Profile, prefix: string): Promise<{ name: string; bytes: Uint8Array }[]> {
  const run = async () => {
    await ensureReady(p);
    const g = info(p).activeGeneration;
    const out: { name: string; bytes: Uint8Array }[] = [];
    for (const kind of KINDS) {
      const base = `g${g}/${kind}/`;
      const entries = await p.idb.read({
        readId: '0', keys: [], prefix: `${base}${prefix}`, after: '', limit: 0,
      });
      for (const e of entries) {
        try {
          out.push({ name: e.key.slice(base.length), bytes: p.engine.open(e.key, e.value) });
        } catch {
          // повреждённая запись — пропускаем (не открылась своим ключом)
        }
      }
    }
    return out;
  };
  return p.rotation ? exclusive(p, run) : run();
}

function lockedError() {
  return new Error('E2E storage is protected by a PIN and is locked.');
}

async function isLegacyUser(ctx: Ctx, user: string) {
  const known = ctx.legacy.get(user);
  if (known !== undefined) return known;
  const legacy = !(await profileIdOf(ctx, user)) && await legacyProfileExists(user);
  ctx.legacy.set(user, legacy);
  return legacy;
}

async function readyProfile(ctx: Ctx, user: string) {
  const p = (await openProfile(ctx, user, true))!;
  await ensureReady(p);
  if (p.engine.state() === 'locked') throw lockedError();
  return p;
}

// ── экземпляр ────────────────────────────────────────────────────────────────────────────────────────────
export class SecureE2eStorage {
  static ctx: Ctx = DEFAULT_CTX;

  protected constructor(
    private readonly ctx: Ctx,
    private readonly user: string,
    private readonly legacy?: LegacyE2eStorage,
  ) {}

  static async open(user: string) {
    const { ctx } = this;
    if (await isLegacyUser(ctx, user)) return new this(ctx, user, await LegacyE2eStorage.open(user));
    await readyProfile(ctx, user);
    return new this(ctx, user);
  }

  private profile() {
    return readyProfile(this.ctx, this.user);
  }

  async load<T>() {
    if (this.legacy) return this.legacy.load<T>();
    const bytes = await readRecord(await this.profile(), STATE_NAME);
    return bytes ? JSON.parse(decoder.decode(bytes)) as T : undefined;
  }

  async save(value: unknown) {
    if (this.legacy) return this.legacy.save(value);
    return writeRecords(this.ctx, await this.profile(), [[STATE_NAME, encoder.encode(JSON.stringify(value))]]);
  }

  async saveRecord(name: string, value: unknown) {
    if (this.legacy) return this.legacy.saveRecord(name, value);
    return writeRecords(this.ctx, await this.profile(), [[name, encoder.encode(JSON.stringify(value))]]);
  }

  async loadRecord<T>(name: string): Promise<T | undefined> {
    if (this.legacy) return this.legacy.loadRecord<T>(name);
    const bytes = await readRecord(await this.profile(), name);
    if (!bytes) return undefined;
    try {
      return JSON.parse(decoder.decode(bytes)) as T;
    } catch {
      return undefined;
    }
  }

  async saveRecords(entries: [name: string, value: unknown][]) {
    if (this.legacy) return this.legacy.saveRecords(entries);
    if (!entries.length) return undefined;
    return writeRecords(this.ctx, await this.profile(),
      entries.map(([name, value]) => [name, encoder.encode(JSON.stringify(value))]));
  }

  async deleteRecords(names: string[]) {
    if (this.legacy) return this.legacy.deleteRecords(names);
    if (!names.length) return undefined;
    return writeRecords(this.ctx, await this.profile(), [], names);
  }

  async loadRecordsByPrefix<T>(prefix: string): Promise<T[]> {
    if (this.legacy) return this.legacy.loadRecordsByPrefix<T>(prefix);
    const rows = await readPrefix(await this.profile(), prefix);
    const out: T[] = [];
    rows.forEach(({ bytes }) => {
      try {
        out.push(JSON.parse(decoder.decode(bytes)) as T);
      } catch {
        // двоичная запись под тем же префиксом — не JSON
      }
    });
    return out;
  }

  async saveBytesRecord(name: string, bytes: Uint8Array) {
    if (this.legacy) return this.legacy.saveBytesRecord(name, bytes);
    return writeRecords(this.ctx, await this.profile(), [[name, bytes]]);
  }

  async loadBytesRecord(name: string): Promise<Uint8Array | undefined> {
    if (this.legacy) return this.legacy.loadBytesRecord(name);
    return readRecord(await this.profile(), name);
  }

  async deleteRecord(name: string) {
    if (this.legacy) return this.legacy.deleteRecord(name);
    return writeRecords(this.ctx, await this.profile(), [], [name]);
  }

  // ── записи хранилища модели движка (spec 035 T113, `v2/engine.ts` `secureModelStore`) ──────────────────
  // Модель шифрует свои записи сама (свой DEK); здесь они лежат ещё и под ключом профиля (PIN, вкладки, смена
  // поколения — как у остальных записей). Пачка модели — одна запись хранилища: записи и удаления вместе.

  async writeModelRecords(puts: [name: string, bytes: Uint8Array][], deletes: string[]) {
    if (this.legacy) {
      // Прежний профиль (до T115): значение — JSON с именем, иначе префиксное чтение не вернёт имён
      if (puts.length) await this.legacy.saveRecords(puts.map(([name, bytes]) => [name, { k: name, v: toB64(bytes) }]));
      if (deletes.length) await this.legacy.deleteRecords(deletes);
      return undefined;
    }
    if (!puts.length && !deletes.length) return undefined;
    return writeRecords(this.ctx, await this.profile(), puts, deletes);
  }

  async loadModelRecord(name: string): Promise<Uint8Array | undefined> {
    if (this.legacy) {
      const r = await this.legacy.loadRecord<{ k: string; v: string }>(name);
      return r?.v !== undefined ? fromB64(r.v) : undefined;
    }
    return readRecord(await this.profile(), name);
  }

  async loadModelRecords(prefix: string): Promise<{ name: string; bytes: Uint8Array }[]> {
    if (this.legacy) {
      const rows = await this.legacy.loadRecordsByPrefix<{ k: string; v: string }>(prefix);
      return rows.filter((r) => r && typeof r.k === 'string').map((r) => ({ name: r.k, bytes: fromB64(r.v) }));
    }
    return (await readPrefix(await this.profile(), prefix)).filter((r) => r.name.startsWith(prefix));
  }

  static async clear(user: string) {
    return clearIn(this.ctx, user);
  }

  static async clearRecords(user: string) {
    return clearRecordsIn(this.ctx, user);
  }
}

async function clearIn(ctx: Ctx, user: string) {
  ctx.legacy.delete(user);
  clearedListeners.forEach((fn) => fn(user));
  await LegacyE2eStorage.clear(user);
  const p = await openProfile(ctx, user, false).catch(() => undefined);
  const id = p?.id || await profileIdOf(ctx, user);
  if (p) {
    await p.rotation?.catch(() => undefined);
    p.engine.storeLock();
    await exclusive(p, () => p.idb.clearAll());
  } else if (id) {
    const idb = await openStoreIdb(`${STORE_DB}-${id}`);
    await idb.clearAll();
    idb.close();
  }
  forgetProfile(ctx, user);
  if (id) await del(id, KEYS);
  const dir = await directory(ctx);
  await dir.commit({ batchId: '0', puts: [], deletes: [`profile/${user}`] });
}

async function clearRecordsIn(ctx: Ctx, user: string) {
  if (await isLegacyUser(ctx, user)) {
    await LegacyE2eStorage.clearRecords(user);
    return;
  }
  const p = await openProfile(ctx, user, false);
  if (!p) return;
  await ensureReady(p);
  if (p.engine.state() !== 'ready') return;
  const names = (await readPrefix(p, '')).map((r) => r.name).filter((name) => name !== STATE_NAME);
  await writeRecords(ctx, p, [], names);
}

function forgetProfile(ctx: Ctx, user: string) {
  const p = ctx.resolved.get(user);
  ctx.resolved.delete(user);
  ctx.profiles.delete(user);
  if (p) {
    p.signal.close();
    p.idb.close();
    try {
      p.engine.free();
    } catch {
      // уже освобождён
    }
  }
}

// ── PIN (P-39 → spec 035) ────────────────────────────────────────────────────────────────────────────────
async function hasPinIn(ctx: Ctx, user: string) {
  if (await isLegacyUser(ctx, user)) return legacyHasStoragePin(user);
  const p = await openProfile(ctx, user, false);
  return Boolean(p && info(p).wraps.includes('pin'));
}

function isUnlockedIn(ctx: Ctx, user: string) {
  if (ctx.legacy.get(user)) return legacyIsStorageUnlocked(user);
  const p = ctx.resolved.get(user);
  return Boolean(p && p.engine.state() === 'ready' && info(p).wraps.includes('pin'));
}

async function unlockWithPinIn(ctx: Ctx, user: string, pin: string): Promise<boolean> {
  if (await isLegacyUser(ctx, user)) return legacyUnlockStorageWithPin(user, pin);
  const p = await openProfile(ctx, user, false);
  if (!p) return true;
  const i = info(p);
  if (!i.wraps.includes('pin') || !i.pinSalt || !i.pinIterations) return true;
  if (p.engine.state() === 'ready') return true;
  const kek = await pinKek(pin, unhex(i.pinSalt), i.pinIterations);
  try {
    p.engine.storeUnlock(kek, true);
  } catch {
    return false;
  } finally {
    kek.fill(0);
  }
  resumeRotation(ctx, p);
  return true;
}

function lockIn(ctx: Ctx, user: string) {
  if (ctx.legacy.get(user)) {
    legacyLockStorage(user);
    return;
  }
  const p = ctx.resolved.get(user);
  if (!p) return;
  if (!info(p).wraps.includes('pin')) return; // без PIN профиль открывает ключ устройства — блокировать нечего
  p.engine.storeLock();
  p.signal.post('storage-locked');
}

async function setPinIn(ctx: Ctx, user: string, pin: string) {
  if (await isLegacyUser(ctx, user)) {
    await legacySetStoragePin(user, pin);
    return;
  }
  if (pin && pin.length < STORAGE_PIN_MIN_LENGTH) throw new Error('Storage PIN is too short.');
  const p = (await openProfile(ctx, user, true))!;
  await ensureReady(p);
  if (p.engine.state() !== 'ready') throw new Error('Storage is locked: unlock with the current PIN first.');
  if (pin) {
    const salt = randomBytes(16);
    const kek = await pinKek(pin, salt, PIN_ITERATIONS);
    await exclusive(p, async () => {
      await syncRoot(ctx, p);
      if (p.engine.state() !== 'ready') throw new Error('Storage is locked: unlock with the current PIN first.');
      // Одна транзакция: обёртка PIN в корне вместо обёртки устройства и удаление записи устройства
      const batch = p.engine.storeSetPin(salt, PIN_ITERATIONS, kek) as JsBatch;
      batch.deletes.push(DEVICE_KEY);
      await commit(ctx, p, batch);
      p.signal.post('storage-wrap-changed');
      // Смена DEK поколением (P1): копия профиля, снятая до PIN, не откроет записи после переноса
      const i = info(p);
      if (!i.pendingGeneration && !i.retiringGeneration) {
        await commit(ctx, p, p.engine.beginRotation() as JsBatch);
        p.signal.post('storage-wrap-changed');
      }
    }).finally(() => kek.fill(0));
    void runRotation(ctx, p);
    return;
  }
  // Снятие: новый ключ устройства, обёртка устройства вместо PIN — корень и запись устройства одной транзакцией
  const raw = randomBytes(32);
  const sealed = await sealDevice(p.id, raw);
  await exclusive(p, async () => {
    await syncRoot(ctx, p);
    if (p.engine.state() !== 'ready') throw new Error('Storage is locked: unlock with the current PIN first.');
    const batch = p.engine.storeRemovePin(raw) as JsBatch;
    batch.puts.push({ key: DEVICE_KEY, value: sealed });
    await commit(ctx, p, batch);
    p.signal.post('storage-wrap-changed');
  }).finally(() => raw.fill(0));
}

// Смена ника (spec 026 → spec 035 T047): AAD записей не зависит от адреса — переносится только указатель
// «адрес → профиль»; записи не перешифровываются
async function renameIn(ctx: Ctx, oldUser: string, newUser: string) {
  if (oldUser === newUser) return;
  if (await isLegacyUser(ctx, oldUser)) {
    await legacyMigrateStorageUser(oldUser, newUser);
    ctx.legacy.delete(oldUser);
    ctx.legacy.delete(newUser);
    return;
  }
  const id = await profileIdOf(ctx, oldUser);
  if (!id) return;
  const dir = await directory(ctx);
  await dir.commit({
    batchId: '0', puts: [{ key: `profile/${newUser}`, value: encoder.encode(id) }], deletes: [`profile/${oldUser}`],
  });
  const pending = ctx.profiles.get(oldUser);
  const p = ctx.resolved.get(oldUser);
  ctx.profiles.delete(oldUser);
  ctx.resolved.delete(oldUser);
  ctx.legacy.delete(newUser);
  if (pending && p) {
    p.user = newUser;
    ctx.profiles.set(newUser, pending);
    ctx.resolved.set(newUser, p);
  }
}

// ── секреты сессии (P-14/P-39) ───────────────────────────────────────────────────────────────────────────
async function saveSecretIn(ctx: Ctx, user: string, name: string, value: string) {
  const p = await openProfile(ctx, user, true);
  await ensureReady(p!);
  if (p!.engine.state() !== 'ready') throw new Error('Storage is locked.');
  await writeRecords(ctx, p!, [[name, encoder.encode(JSON.stringify(value))]]);
}

async function loadSecretIn(ctx: Ctx, user: string, name: string) {
  const p = await openProfile(ctx, user, false);
  if (!p) return undefined;
  await ensureReady(p).catch(() => undefined);
  if (p.engine.state() !== 'ready') return undefined;
  const bytes = await readRecord(p, name);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as unknown;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

async function clearSecretIn(ctx: Ctx, user: string, name: string) {
  const p = await openProfile(ctx, user, false);
  if (!p) return;
  await ensureReady(p).catch(() => undefined);
  if (p.engine.state() !== 'ready') return;
  await writeRecords(ctx, p, [], [name]);
}

function makeApi(ctx: Ctx) {
  const legacyOr = <A extends unknown[], R>(
    legacyFn: (user: string, ...args: A) => Promise<R>, fn: (user: string, ...args: A) => Promise<R>,
  ) => async (user: string, ...args: A) => (
    (await isLegacyUser(ctx, user)) ? legacyFn(user, ...args) : fn(user, ...args)
  );
  return {
    hasStoragePin: (user: string) => hasPinIn(ctx, user),
    isStorageUnlocked: (user: string) => isUnlockedIn(ctx, user),
    unlockStorageWithPin: (user: string, pin: string) => unlockWithPinIn(ctx, user, pin),
    lockStorage: (user: string) => lockIn(ctx, user),
    setStoragePin: (user: string, pin: string) => setPinIn(ctx, user, pin),
    renameStorageUser: (oldUser: string, newUser: string) => renameIn(ctx, oldUser, newUser),
    saveTrustSecret: legacyOr(legacySaveTrustSecret,
      (user: string, secret: string) => saveSecretIn(ctx, user, 'trust-secret', secret)),
    loadTrustSecret: legacyOr(legacyLoadTrustSecret, (user: string) => loadSecretIn(ctx, user, 'trust-secret')),
    clearTrustSecret: legacyOr(legacyClearTrustSecret, (user: string) => clearSecretIn(ctx, user, 'trust-secret')),
    saveSecureSession: legacyOr(legacySaveSecureSession,
      (user: string, token: string) => saveSecretIn(ctx, user, 'session-token', token)),
    loadSecureSession: legacyOr(legacyLoadSecureSession, (user: string) => loadSecretIn(ctx, user, 'session-token')),
    clearSecureSession: legacyOr(legacyClearSecureSession,
      (user: string) => clearSecretIn(ctx, user, 'session-token')),
    getStorageMigration: (user: string): StorageMigration | undefined => {
      const p = ctx.resolved.get(user);
      return p ? { ...p.migration } : undefined;
    },
  };
}

const api = makeApi(DEFAULT_CTX);
export const {
  hasStoragePin, isStorageUnlocked, unlockStorageWithPin, lockStorage, setStoragePin, renameStorageUser,
  saveTrustSecret, loadTrustSecret, clearTrustSecret, saveSecureSession, loadSecureSession, clearSecureSession,
  getStorageMigration,
} = api;

/**
 * Есть ли запись профиля — без создания профиля (диаг-методы провайдера, сценарии e2e). `undefined` — профиль
 * заблокирован PIN и запись не прочитать.
 */
export async function peekSecureRecord(user: string, name: string): Promise<boolean | undefined> {
  const ctx = DEFAULT_CTX;
  if (await isLegacyUser(ctx, user)) {
    return (await (await LegacyE2eStorage.open(user)).loadBytesRecord(name)) !== undefined;
  }
  const p = await openProfile(ctx, user, false);
  if (!p) return false;
  await ensureReady(p).catch(() => undefined);
  if (p.engine.state() !== 'ready') return undefined;
  return (await readRecord(p, name)) !== undefined;
}

/** Профиль хранилища адреса есть (новый или прежний `parvane-e2e-v2`) — без создания. */
export async function hasSecureProfile(user: string) {
  return Boolean(await profileIdOf(DEFAULT_CTX, user)) || isLegacyUser(DEFAULT_CTX, user);
}

/** Ход фоновой смены ключа хранилища (T044) — для экрана хода. Возвращает отписку. */
export function onStorageMigration(listener: (user: string, state: StorageMigration) => void) {
  migrationListeners.add(listener);
  return () => {
    migrationListeners.delete(listener);
  };
}

/** Хранилище заблокировала другая вкладка (смена PIN, перенос поколения): DEK забыт, нужен PIN. */
export function onStorageLocked(listener: (user: string) => void) {
  lockedListeners.add(listener);
  return () => {
    lockedListeners.delete(listener);
  };
}

/** Хранилище адреса стёрто (`SecureE2eStorage.clear`) — кэши в памяти поверх него недействительны. */
export function onStorageCleared(listener: (user: string) => void) {
  clearedListeners.add(listener);
  return () => {
    clearedListeners.delete(listener);
  };
}

export const secureStorageInternals = {
  ...legacyStorageInternals,
  // Тесты: «перезагрузка страницы» — в памяти не остаётся ни DEK, ни профилей
  forgetAll: () => {
    [...DEFAULT_CTX.resolved.keys()].forEach((user) => forgetProfile(DEFAULT_CTX, user));
    DEFAULT_CTX.profiles.clear();
    DEFAULT_CTX.legacy.clear();
  },
  // Тесты: дождаться фонового переноса поколения
  settled: async (user: string) => {
    for (;;) {
      const p = DEFAULT_CTX.resolved.get(user);
      if (!p?.rotation) return;
      await p.rotation;
    }
  },
  // Тесты: отказ записи пачки (нет места) — предикат по числу записей и удалений
  failCommits: (pred?: (puts: number, deletes: number) => boolean) => {
    DEFAULT_CTX.failPred = pred;
  },
  // Тесты: значения записей активного поколения на носителе (имя → hex)
  rawRecords: async (user: string) => {
    const out = new Map<string, string>();
    const p = await openProfile(DEFAULT_CTX, user, false);
    if (!p) return out;
    const g = info(p).activeGeneration;
    const entries = await p.idb.read({
      readId: '0', keys: [], prefix: `g${g}/`, after: '', limit: 0,
    });
    entries.forEach((e) => out.set(e.key.slice(e.key.indexOf('/', e.key.indexOf('/') + 1) + 1), hex(e.value)));
    return out;
  },
  // Тесты: вторая вкладка того же браузера — свой движок и свои DEK в памяти
  createTab: () => {
    const ctx = newCtx();
    class TabStorage extends SecureE2eStorage {
      static ctx = ctx;
    }
    return { ...makeApi(ctx), SecureE2eStorage: TabStorage };
  },
  kindOf,
  keysStore: KEYS,
  profileIdOf: (user: string) => profileIdOf(DEFAULT_CTX, user),
  // Тесты: запись устройства (`device`) в базе профиля есть
  hasDeviceRecord: async (user: string) => {
    const p = await openProfile(DEFAULT_CTX, user, false);
    return Boolean(p && await readKey(p.idb, DEVICE_KEY));
  },
};
