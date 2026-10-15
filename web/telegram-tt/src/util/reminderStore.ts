// Напоминания для service worker (этап 4 плана 15 окт 2026). Закрытое приложение будит сервер пустым
// пробуждением в момент напоминания (`push.alarm.set` — сервер знает только время); что напомнить, service worker
// читает отсюда: ближайшие напоминания, которые страница кладёт заранее. Тексты зашифрованы ключом AES-GCM без
// выгрузки, который лежит в той же базе — как ключ защищённого хранилища устройства. При PIN хранилища страница
// кладёт напоминания без текста (тогда — общий заголовок).
const DB_NAME = 'parvane-reminders';
const STORE = 'kv';
const KEY_RECORD = 'key';
const DATA_RECORD = 'data';
const SHOWN_RECORD = 'shown';
// Пробуждение приходит не точно в срок: сработавшим считается всё, что наступит в ближайшую минуту
const EARLY_MS = 60 * 1000;
// Старое (устройство было выключено) не показывается — его допишет в «Избранное» открытое приложение
const LATE_MS = 6 * 60 * 60 * 1000;
const MAX_SHOWN = 200;

export type WorkerReminder = { key: string; at: number; title?: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

function write(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function cryptoKey(db: IDBDatabase) {
  const saved = await read<CryptoKey>(db, KEY_RECORD);
  if (saved) return saved;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await write(db, KEY_RECORD, key);
  return key;
}

type Sealed = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

/** Страница: ближайшие напоминания (заменяют прежние). */
export async function saveWorkerReminders(items: WorkerReminder[]) {
  const db = await openDb();
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(items));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(db), plain);
    await write(db, DATA_RECORD, { iv, data } satisfies Sealed);
  } finally {
    db.close();
  }
}

/** Выход из аккаунта: напоминаний на устройстве больше нет. */
export async function clearWorkerReminders() {
  const db = await openDb();
  try {
    await write(db, DATA_RECORD, undefined);
    await write(db, SHOWN_RECORD, []);
  } finally {
    db.close();
  }
}

/** Service worker: наступившие и ещё не показанные напоминания; отмечаются показанными. */
export async function takeDueWorkerReminders(now: number): Promise<WorkerReminder[]> {
  const db = await openDb();
  try {
    const sealed = await read<Sealed>(db, DATA_RECORD);
    if (!sealed) return [];
    const key = await read<CryptoKey>(db, KEY_RECORD);
    if (!key) return [];
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.data);
    const items = JSON.parse(new TextDecoder().decode(plain)) as WorkerReminder[];
    const shown = new Set(await read<string[]>(db, SHOWN_RECORD) || []);
    const due = items.filter(({ key: id, at }) => at <= now + EARLY_MS && at >= now - LATE_MS && !shown.has(id));
    if (due.length) {
      await write(db, SHOWN_RECORD, [...shown, ...due.map(({ key: id }) => id)].slice(-MAX_SHOWN));
    }
    return due;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Страница: напоминание уже показано (открытым приложением) — service worker его не повторит. */
export async function markWorkerReminderShown(key: string) {
  const db = await openDb();
  try {
    const shown = await read<string[]>(db, SHOWN_RECORD) || [];
    if (!shown.includes(key)) await write(db, SHOWN_RECORD, [...shown, key].slice(-MAX_SHOWN));
  } finally {
    db.close();
  }
}
