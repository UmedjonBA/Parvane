// spec 035 T027 (contracts/storage.md, R2): адаптер хранилища движка для web — IndexedDB `parvane-store-v3`.
// Движок sans-IO выпускает `store_batch` и `store_reads`; здесь — только ввод-вывод:
//  - пачка — ОДНА транзакция readwrite (сначала удаления, затем записи); корень `root` (указатель поколения,
//    обёртки DEK) — обычный ключ той же базы, поэтому его смена атомарна вместе с записями пачки;
//    хост MUST дождаться `commit` до отправки запросов того же результата движка (SYNC-1);
//  - чтение — по ключам (только существующие, в порядке запроса) и/или по префиксу (строго после `after`,
//    по возрастанию ключа, не больше `limit`; 0 — без предела).
// Ключи сравниваются как строки JS (UTF-16); у ключей движка (ASCII и адреса) порядок совпадает с порядком
// байтов UTF-8 ядра. Прежняя база `parvane-e2e-v2` здесь не открывается — её читает только перенос.
import type { StoreBatch, StorePut, StoreReads } from './gen/model';

import { storeBatchFromJson, storeLoadedToJson, storeReadsFromJson } from './gen/model';

export const STORE_DB = 'parvane-store-v3';
const RECORDS = 'records';

export interface CommitOptions {
  // Тесты: отменить транзакцию после стольких шагов (удаление/запись) — «прерванная пачка».
  abortAfter?: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('store_batch: транзакция отменена'));
    tx.onerror = () => reject(tx.error ?? new Error('store_batch: ошибка транзакции'));
  });
}

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(0);
}

export class StoreIdb {
  constructor(readonly name: string, private readonly db: IDBDatabase) {}

  async commit(batch: StoreBatch, opts: CommitOptions = {}): Promise<void> {
    const tx = this.db.transaction(RECORDS, 'readwrite');
    const finished = done(tx);
    const store = tx.objectStore(RECORDS);
    let steps = 0;
    const abortNow = () => opts.abortAfter !== undefined && steps === opts.abortAfter;
    try {
      for (const key of batch.deletes) {
        if (abortNow()) throw new Error('abort');
        store.delete(key);
        steps++;
      }
      for (const p of batch.puts) {
        if (abortNow()) throw new Error('abort');
        store.put(p.value, p.key);
        steps++;
      }
      if (abortNow()) throw new Error('abort');
    } catch (e) {
      tx.abort();
      await finished.catch(() => undefined);
      throw e;
    }
    await finished;
  }

  async read(reads: StoreReads): Promise<StorePut[]> {
    const tx = this.db.transaction(RECORDS, 'readonly');
    const store = tx.objectStore(RECORDS);
    const out: StorePut[] = [];
    for (const key of reads.keys) {
      const v = await request(store.get(key));
      if (v !== undefined) out.push({ key, value: asBytes(v) });
    }
    if (reads.prefix) {
      const upper = `${reads.prefix}￿`;
      const range = reads.after && reads.after >= reads.prefix
        ? IDBKeyRange.bound(reads.after, upper, true, false)
        : IDBKeyRange.bound(reads.prefix, upper, false, false);
      await new Promise<void>((resolve, reject) => {
        const cur = store.openCursor(range);
        cur.onerror = () => reject(cur.error);
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) {
            resolve();
            return;
          }
          const key = c.key as string;
          if (!key.startsWith(reads.prefix) || (reads.limit !== 0 && out.length >= reads.limit)) {
            resolve();
            return;
          }
          out.push({ key, value: asBytes(c.value) });
          c.continue();
        };
      });
    }
    return out;
  }

  // Всё содержимое по возрастанию ключа (перенос, тесты).
  async readAll(): Promise<StorePut[]> {
    const tx = this.db.transaction(RECORDS, 'readonly');
    const store = tx.objectStore(RECORDS);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    return keys.map((k, i) => ({ key: k as string, value: asBytes(values[i]) }));
  }

  // Граница движка — proto3-JSON `parvane.engine.v1.StoreBatch`.
  commitJson(json: string): Promise<void> {
    return this.commit(storeBatchFromJson(JSON.parse(json)));
  }

  // `parvane.engine.v1.StoreReads` → `parvane.engine.v1.StoreLoaded` (proto3-JSON).
  async readJson(json: string): Promise<string> {
    const reads = storeReadsFromJson(JSON.parse(json));
    const entries = await this.read(reads);
    return JSON.stringify(storeLoadedToJson({ readId: reads.readId, entries }));
  }

  close() {
    this.db.close();
  }
}

export function openStoreIdb(name = STORE_DB, factory: IDBFactory = indexedDB): Promise<StoreIdb> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(RECORDS)) r.result.createObjectStore(RECORDS);
    };
    r.onsuccess = () => resolve(new StoreIdb(name, r.result));
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`${name}: база занята другой вкладкой`));
  });
}
