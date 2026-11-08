// Протокол v2 (spec 007, E2): загрузка WASM-движка `parvane-protocol`.
// Модуль собирается `backend/protocol/wasm/build.sh` в src/lib/parvane-protocol.

import type { StoreBatch, StorePut, StoreReads } from './gen/model';

import init, * as pv from '../../../lib/parvane-protocol/parvane_protocol';
import wasmUrl from '../../../lib/parvane-protocol/parvane_protocol_bg.wasm?url';
import { base64ToBytes } from './base64';
import { storeBatchFromJson, storeLoadedToJson, storeReadsFromJson } from './gen/model';

export type Protocol = typeof pv;
export type {
  PvClient, PvHistory, PvState,
} from '../../../lib/parvane-protocol/parvane_protocol';

let loading: Promise<Protocol> | undefined;
let loaded: Protocol | undefined;

/** Загрузить и инициализировать движок (один раз на страницу). */
export function loadProtocol(): Promise<Protocol> {
  if (!loading) {
    loading = init({ module_or_path: wasmUrl }).then(() => {
      loaded = pv;
      return pv;
    }).catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  }
  return loading;
}

/** Ошибка движка: {need} (добрать данные) или {error} (вид ProtoError). */
export type EngineError =
  | { need: { kind: string; user?: string; after?: number; group?: string; epoch?: number } }
  | { error: string };

export function parseEngineError(e: unknown): EngineError {
  try {
    return JSON.parse(String(e)) as EngineError;
  } catch {
    return { error: String(e) };
  }
}

/** REPORT-1 (A0008-2): подпись автора сообщения из жалобы верна — цепочка «корень → устройство → операция»,
 * автор, `op_id`, начало текста и (если задан `groupHex`) группа беседы совпадают с подписанными.
 * Движок не загружен — нет. */
export function verifyMessageProof(
  proofB64: string, opId: string, author: string, text: string, groupHex = '',
): boolean {
  if (!loaded || !proofB64) return false;
  try {
    const bytes = base64ToBytes(proofB64);
    return Boolean((JSON.parse(pv.verifyMessageProof(bytes, opId, author, text, groupHex)) as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}

/** Статическая функция журнала истории движка (spec 033, `historyCall`): результат — разобранный JSON. Отказ
 * (`{"error": …}`) либо не инициализированный движок — исключение. */
export function historyStatic<T>(name: string, args: unknown = {}): T {
  return JSON.parse(pv.historyCall(name, JSON.stringify(args))) as T;
}

// ── Модель движка (spec 035, T112; contracts/engine-api.md) ─────────────────────────────────────────────
//
// Единственная точка вызова модели в web (ENGINE-1): `ModelHost` держит `PvEngine` и выполняет его итоги
// (`Outcome`) sans-IO: пачку хранилища фиксирует ДО отправки запросов того же итога, затем сообщает
// `storeCommitted` (порядок «на диске раньше подтверждения», SYNC-1); чтения хранилища (`store_reads`) читает и
// возвращает `storeLoaded`. Вызовы движка идут строго по одному (очередь обещаний): ответ сервера, пришедший во
// время фиксации пачки, подаётся следующим вызовом. Граница — proto3-JSON с именами полей схемы (snake_case).

/** Хранилище модели: одна транзакция на пачку, чтение по ключам/префиксу (`StoreIdb` подходит как есть). */
export interface ModelStore {
  commit(batch: StoreBatch): Promise<void>;
  read(reads: StoreReads): Promise<StorePut[]>;
}

/** Запрос движка серверу (proto3-JSON `OutRequest`). */
export type ModelRequest = {
  req_id: string;
  method: string;
  channel?: string;
  body?: string;
  deadline_ms?: string;
  dest_domain?: string;
};

export type ModelJson = Record<string, unknown>;

export interface ModelHostDeps {
  store: ModelStore;
  /** Отправить запрос; ответ — `host.ingestResponse(req_id, …)`. Вызывается только после фиксации пачки. */
  send: (req: ModelRequest) => void;
  /** Изменения модели по порядку (`ModelDelta` proto3-JSON). */
  onDelta?: (delta: ModelJson) => void;
  /** Итог открытия (`OpenResult`). */
  onOpen?: (open: ModelJson) => void;
  log?: (message: string) => void;
}

/** Ошибка вызова модели: вид `ProtoError` (`{"error": …}`). */
export class ModelError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

type EngineLike = { call: (name: string, args: string) => string; free?: () => void };

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Хост модели движка поверх хранилища и транспорта. */
export class ModelHost {
  private chain: Promise<unknown> = Promise.resolve();

  private closed = false;

  constructor(private readonly engine: EngineLike, private readonly deps: ModelHostDeps) {}

  /** Открыть модель (`EngineConfig` proto3-JSON): чтение корня и профиля, итог открытия — `deps.onOpen`. */
  static async open(config: ModelJson, deps: ModelHostDeps, engineFactory?: (cfg: string) => EngineLike) {
    const make = engineFactory ?? ((cfg: string) => {
      if (!loaded) throw new Error('движок не загружен');
      return loaded.PvEngine.open(cfg) as EngineLike;
    });
    const host = new ModelHost(make(JSON.stringify(config)), deps);
    const opened: ModelJson[] = [];
    const onOpen = deps.onOpen;
    host.deps.onOpen = (o) => {
      opened.push(o);
      onOpen?.(o);
    };
    await host.run('start', {});
    host.deps.onOpen = onOpen;
    return { host, open: opened[opened.length - 1] };
  }

  /** Вызов модели с выполнением итога; результат — итог (`Outcome`) первого вызова. */
  run(name: string, args: unknown): Promise<ModelJson> {
    return this.serial(() => this.drive(this.raw(name, args)));
  }

  /** Намерение (`Intent` proto3-JSON, например `{state_patch: {...}}`). */
  submit(intent: ModelJson) {
    return this.run('submit', intent);
  }

  tick(nowMs = Date.now()) {
    return this.run('tick', { now_ms: String(nowMs) });
  }

  /** Ответ сервера на запрос модели. `error` — номер `ErrorCode` (0 — успех). */
  ingestResponse(reqId: string, body: Uint8Array, error = 0) {
    return this.run('ingest', {
      kind: 'SERVER_INPUT_KIND_RESPONSE', req_id: reqId, body: b64(body), error,
    });
  }

  /** Событие сервера, адресованное модели (`method` — вид события). */
  ingestEvent(method: string, body: Uint8Array = new Uint8Array(0)) {
    return this.run('ingest', { kind: 'SERVER_INPUT_KIND_EVENT', method, body: b64(body) });
  }

  /** Чтение модели (`viewState`, `viewGroup`, `capabilities`, `chatList`, `historyPage`, `engineInfo`). Строк нет в
   * памяти (`pending`) — хост дочитывает их и повторяет вызов. */
  async view<T = ModelJson>(name: string, args: unknown = {}): Promise<T> {
    return this.serial(async () => {
      for (let i = 0; i < 4; i++) {
        const out = this.raw(name, args);
        const pending = (out.pending as { store_reads?: ModelJson[] } | undefined)?.store_reads;
        if (!pending?.length) return out as T;
        await this.drive({ store_reads: pending });
      }
      throw new ModelError('Pending');
    });
  }

  /** Чтение модели без очереди (только то, что уже в памяти движка). */
  peek<T = ModelJson>(name: string, args: unknown = {}): T {
    return this.raw(name, args) as T;
  }

  close() {
    this.closed = true;
    this.engine.free?.();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private raw(name: string, args: unknown): ModelJson {
    if (this.closed) throw new ModelError('Closed');
    const text = this.engine.call(name, typeof args === 'string' ? args : JSON.stringify(args ?? {}));
    const out = JSON.parse(text) as ModelJson;
    if (typeof out.error === 'string') throw new ModelError(out.error);
    return out;
  }

  /** Выполнить итог целиком: изменения, пачку (фиксация → запросы → `storeCommitted`), чтения. Порядок обхода —
   * тот же, что у эталонного хоста `backend/protocol/tests/model_common` (векторы сверяют запросы по порядку). */
  private async drive(first: ModelJson): Promise<ModelJson> {
    const queue: ModelJson[] = [first];
    while (queue.length) {
      const out = queue.pop()!;
      const delta = out.delta as ModelJson | undefined;
      if (delta) this.deps.onDelta?.(delta);
      if (out.open) this.deps.onOpen?.(out.open as ModelJson);
      const batch = out.store_batch as ModelJson | undefined;
      let batchId: string | undefined;
      if (batch) {
        const typed = storeBatchFromJson(batch);
        await this.deps.store.commit(typed);
        batchId = typed.batchId || '0';
      }
      for (const r of (out.requests as ModelRequest[] | undefined) ?? []) this.deps.send(r);
      for (const r of (out.store_reads as ModelJson[] | undefined) ?? []) {
        const reads = storeReadsFromJson(r);
        const entries = await this.deps.store.read(reads);
        queue.push(this.raw('storeLoaded', storeLoadedToJson({ readId: reads.readId, entries })));
      }
      if (batchId !== undefined) queue.push(this.raw('storeCommitted', { batch_id: batchId }));
    }
    return first;
  }
}

/** Хранилище модели в памяти (тесты, векторы). */
export class MemoryModelStore implements ModelStore {
  readonly data = new Map<string, Uint8Array>();

  readonly log: string[] = [];

  commit(batch: StoreBatch) {
    batch.deletes.forEach((k) => this.data.delete(k));
    batch.puts.forEach((p) => this.data.set(p.key, p.value));
    this.log.push(`batch:${batch.batchId}`);
    return Promise.resolve();
  }

  read(reads: StoreReads) {
    const out: StorePut[] = [];
    reads.keys.forEach((key) => {
      const value = this.data.get(key);
      if (value) out.push({ key, value });
    });
    if (reads.prefix) {
      const keys = [...this.data.keys()].filter((k) => k.startsWith(reads.prefix) && k > reads.after).sort();
      const limited = reads.limit ? keys.slice(0, reads.limit) : keys;
      limited.forEach((key) => out.push({ key, value: this.data.get(key)! }));
    }
    return Promise.resolve(out);
  }
}
