// spec 035 T046 (PV-020, FR-026, data-model.md §2): личные данные web — контакты, своё имя и заметка контакта,
// блокировки, ссылки-приглашения, папки, закреплённые/архивные, уведомления, кэш групп v2 и прочее из перечня —
// в хранилище движка (`SecureE2eStorage`, вид `state-object` / `group-view`), под PIN вместе с ключами E2E.
// В localStorage они больше не пишутся.
//
// Чтение синхронное — из памяти после `hydratePersonal()`; запись — в память сразу, на диск пачкой с задержкой.
// До загрузки (ранние вызовы при запуске) читается прежнее значение localStorage профиля, созданного до
// spec 035: оно же разово переносится при загрузке и удаляется из localStorage после записи в хранилище.
import { onStorageCleared, SecureE2eStorage } from './secureStorage';

const SAVE_DELAY_MS = 300;
const LOCAL_PREFIX = 'ls:';
const GROUP_PREFIX = 'gv:';
// Прежний кэш сведений групп (до spec 035 T118): своего кэша групп у web больше нет — сведения из журналов
// групп модели движка. Прежний ключ localStorage ещё переносится в хранилище, чтобы не лежать открытым (PV-020)
const GROUP_PART = 'v2groups';

// Виды `parvane:<вид>:<адрес>` прежнего localStorage, которые переносит загрузка (data-model.md §2)
export const PERSONAL_PARTS = [
  'blocked', 'contacts', 'contactinfo', 'noncontacts', 'unreadpeers', 'unreadmarks', 'invites', 'folders',
  'folders_all_index', 'pinned', 'archived', 'notify', 'notifydefaults', 'quickreaction', 'stickerpacks',
  'stickersetorder', 'renames', 'ttl', 'cleareduntil', 'deletedchats', 'receipts', 'favestickers', 'recentstickers',
  GROUP_PART,
] as const;

// spec 035 T118: виды, которые ведёт журнал личного состояния модели движка (`state.v2`). После первого переноса
// журнала (`MODEL_BACKED_MARK`) их значение — проекция показа модели (`viewStateJson`, объекты по видам) в памяти; на диске вид лежит,
// только пока несёт правку пользователя, ещё не принятую журналом (переживает перезагрузку до подключения), —
// принятую стирает `personalDropFromDisk`. Своей копии журнала у web нет
export const MODEL_BACKED_PARTS = [
  'folders', 'folders_all_index', 'blocked', 'archived', 'pinned', 'notify', 'notifydefaults', 'unreadpeers',
  'quickreaction', 'stickerpacks', 'contacts', 'contactinfo',
] as const;
const MODEL_BACKED_MARK = 'modelbacked';

type Entry = { part: string; v: string };

type Cache = {
  user: string;
  values: Map<string, string>;
  // Изменено, но ещё не на диске (значение `undefined` в values — удаление)
  dirty: Set<string>;
  hydrated: boolean;
  hydrating?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
  // Прежние ключи localStorage, которые удалить после записи
  legacyKeys: Set<string>;
  // Виды, чья запись на диске больше не нужна (значение — в памяти, его ведёт модель): стереть запись
  diskDrop: Set<string>;
};

const caches = new Map<string, Cache>();

function legacyKey(user: string, part: string) {
  return `parvane:${part}:${user}`;
}

function recordName(part: string) {
  return part === GROUP_PART ? `${GROUP_PREFIX}${part}` : `${LOCAL_PREFIX}${part}`;
}

function readLegacy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // eslint-disable-line no-null/no-null
  }
}

function removeLegacy(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // приватный режим — ключа и не было
  }
}

function cacheOf(user: string): Cache {
  let cache = caches.get(user);
  if (!cache) {
    cache = {
      user,
      values: new Map(),
      dirty: new Set(),
      hydrated: false,
      chain: Promise.resolve(),
      legacyKeys: new Set(),
      diskDrop: new Set(),
    };
    caches.set(user, cache);
  }
  return cache;
}

/** Значение вида (как `localStorage.getItem`): `null` — нет. */
export function personalGet(user: string, part: string): string | null {
  if (!user) return null; // eslint-disable-line no-null/no-null
  const cache = cacheOf(user);
  if (cache.values.has(part)) return cache.values.get(part) ?? null; // eslint-disable-line no-null/no-null
  if (cache.dirty.has(part)) return null; // eslint-disable-line no-null/no-null
  // До загрузки — прежнее значение localStorage (профиль до spec 035)
  return cache.hydrated ? null : readLegacy(legacyKey(user, part)); // eslint-disable-line no-null/no-null
}

function schedule(cache: Cache) {
  if (cache.timer) return;
  cache.timer = setTimeout(() => {
    cache.timer = undefined;
    void flushCache(cache);
  }, SAVE_DELAY_MS);
}

export function personalSet(user: string, part: string, value: string) {
  if (!user) return;
  const cache = cacheOf(user);
  cache.values.set(part, value);
  cache.dirty.add(part);
  cache.diskDrop.delete(part);
  cache.legacyKeys.add(legacyKey(user, part));
  schedule(cache);
}

export function personalRemove(user: string, part: string) {
  if (!user) return;
  const cache = cacheOf(user);
  cache.values.delete(part);
  cache.dirty.add(part);
  cache.diskDrop.delete(part);
  cache.legacyKeys.add(legacyKey(user, part));
  schedule(cache);
}

/** Значение вида только в памяти (проекция модели, T118): запись вида на диске стирается. `undefined` — нет. */
export function personalSetMemory(user: string, part: string, value: string | undefined) {
  if (!user) return;
  const cache = cacheOf(user);
  if (value === undefined) cache.values.delete(part);
  else cache.values.set(part, value);
  cache.dirty.delete(part);
  cache.diskDrop.add(part);
  cache.legacyKeys.add(legacyKey(user, part));
  schedule(cache);
}

/** Виды приняты журналом (T118; вызывающий отбирает виды без несохранённых правок): значение остаётся в памяти,
 * запись на диске стирается, ещё не записанная — не пишется. */
export function personalDropFromDisk(user: string, parts: readonly string[]) {
  if (!user || !parts.length) return;
  const cache = cacheOf(user);
  parts.forEach((part) => {
    cache.dirty.delete(part);
    cache.diskDrop.add(part);
  });
  schedule(cache);
}

/** Журнал личного состояния уже ведёт виды `MODEL_BACKED_PARTS` (первый перенос сделан). */
export function personalIsModelBacked(user: string) {
  return personalGet(user, MODEL_BACKED_MARK) === '1';
}

export function personalSetModelBacked(user: string) {
  if (personalIsModelBacked(user)) return;
  personalSet(user, MODEL_BACKED_MARK, '1');
}

/** Прежнее значение localStorage вида — прочитать и удалить (разовый перенос старых записей). */
export function takeLegacyLocal(user: string, part: string): string | null {
  const key = legacyKey(user, part);
  const value = readLegacy(key);
  if (value !== null) removeLegacy(key); // eslint-disable-line no-null/no-null
  return value;
}

function flushCache(cache: Cache): Promise<void> {
  cache.chain = cache.chain.then(async () => {
    if (!cache.dirty.size && !cache.diskDrop.size) return;
    const parts = [...cache.dirty];
    const dropped = [...cache.diskDrop].filter((part) => !cache.dirty.has(part));
    const storage = await SecureE2eStorage.open(cache.user).catch(() => undefined);
    if (!storage) return; // заблокировано (PIN) — останется в памяти до разблокировки
    const snapshot = new Map(parts.map((part) => [part, cache.values.get(part)]));
    const puts: [string, Entry][] = [];
    const deletes: string[] = [];
    snapshot.forEach((v, part) => {
      if (v === undefined) deletes.push(recordName(part));
      else puts.push([recordName(part), { part, v }]);
    });
    dropped.forEach((part) => deletes.push(recordName(part)));
    try {
      if (puts.length) await storage.saveRecords(puts);
      if (deletes.length) await storage.deleteRecords(deletes);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[parvane] личные данные не сохранены: ${String(e)}`);
      return;
    }
    // Изменённое во время записи останется грязным до следующей пачки
    snapshot.forEach((v, part) => {
      if (cache.values.get(part) === v) cache.dirty.delete(part);
    });
    dropped.forEach((part) => cache.diskDrop.delete(part));
    cache.legacyKeys.forEach(removeLegacy);
    cache.legacyKeys.clear();
  });
  return cache.chain;
}

/** Записать накопленное сейчас (все адреса либо один). */
export async function flushPersonal(user?: string) {
  const list = user ? [caches.get(user)].filter(Boolean) : [...caches.values()];
  await Promise.all(list.map((cache) => {
    if (cache.timer) {
      clearTimeout(cache.timer);
      cache.timer = undefined;
    }
    return flushCache(cache);
  }));
}

/** Загрузить личные данные из хранилища в память (один раз; повтор — если было заблокировано). */
export function hydratePersonal(user: string): Promise<void> {
  if (!user) return Promise.resolve();
  const cache = cacheOf(user);
  if (cache.hydrated) return Promise.resolve();
  cache.hydrating ||= (async () => {
    const storage = await SecureE2eStorage.open(user).catch(() => undefined);
    if (!storage) return;
    const rows = [
      ...await storage.loadRecordsByPrefix<Entry>(LOCAL_PREFIX),
      ...await storage.loadRecordsByPrefix<Entry>(GROUP_PREFIX),
    ];
    rows.forEach((row) => {
      if (!row || typeof row.part !== 'string' || typeof row.v !== 'string') return;
      // Записанное до загрузки свежее диска
      if (!cache.dirty.has(row.part) && !cache.diskDrop.has(row.part)) cache.values.set(row.part, row.v);
    });
    // Разовый перенос прежнего localStorage: значения, которых в хранилище нет, — в хранилище; ключи — удалить
    PERSONAL_PARTS.forEach((part) => {
      const key = legacyKey(user, part);
      const legacy = readLegacy(key);
      if (legacy === null) return; // eslint-disable-line no-null/no-null
      if (!cache.values.has(part) && !cache.dirty.has(part)) {
        cache.values.set(part, legacy);
        cache.dirty.add(part);
      }
      cache.legacyKeys.add(key);
    });
    cache.hydrated = true;
    if (cache.dirty.size || cache.legacyKeys.size || cache.diskDrop.size) await flushCache(cache);
  })().finally(() => {
    cache.hydrating = undefined;
  });
  return cache.hydrating;
}

/** Выход/смена аккаунта: забыть в памяти (записи хранилища стирает `SecureE2eStorage.clearRecords`). */
export function forgetPersonal(user: string) {
  const cache = caches.get(user);
  if (cache?.timer) clearTimeout(cache.timer);
  caches.delete(user);
}

/** Своя смена ника: записи профиля не зависят от адреса — переезжает только память. */
export function renamePersonal(oldUser: string, newUser: string) {
  const cache = caches.get(oldUser);
  if (!cache || oldUser === newUser) return;
  caches.delete(oldUser);
  cache.user = newUser;
  caches.set(newUser, cache);
}

onStorageCleared((user) => forgetPersonal(user));

export const personalStoreInternals = { caches };
