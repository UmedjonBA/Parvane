// Протокол v2 (spec 007, E2): загрузка WASM-движка `parvane-protocol`.
// Модуль собирается `backend/protocol/wasm/build.sh` в src/lib/parvane-protocol.

import type { StoreBatch, StorePut, StoreReads } from './gen/model';

import init, * as pv from '../../../lib/parvane-protocol/parvane_protocol';
import wasmUrl from '../../../lib/parvane-protocol/parvane_protocol_bg.wasm?url';
import { storeBatchFromJson, storeLoadedToJson, storeReadsFromJson } from './gen/model';
import { base64ToBytes } from './base64';
import { EngineClient } from './engineClient';
import { errorCodeNumber } from './transport';

export type Protocol = typeof pv;
// spec 035 (T113): клиент — в модели движка; прежние имена типов — у её интерфейса (`engineClient.ts`)
export type { EngineClient as PvClient, EngineHistory as PvHistory } from './engineClient';

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
  /** Изменения модели по порядку (`ModelDelta` proto3-JSON). Обещание ждётся ДО фиксации пачки того же итога:
   * хост успевает записать своё (события инбокса в режиме хоста) раньше, чем модель отметит запись применённой
   * и выпустит подтверждение (SYNC-1). Внутри обработчика нельзя ждать других вызовов модели (`run`, `flush`):
   * они встают в очередь за текущим итогом и возвращаются сразу. */
  onDelta?: (delta: ModelJson) => void | Promise<void>;
  /** Итог открытия (`OpenResult`). */
  onOpen?: (open: ModelJson) => void;
  log?: (message: string) => void;
}

/** Отказ открытия модели: данные на устройстве записаны более новой версией движка (`OPEN_STATE_TOO_NEW`, T117). Не
 * `ErrorCode` сервера: обновить нужно приложение, а не из-за отказа сервера. */
export const MODEL_TOO_NEW = 'MODEL_TOO_NEW';

/** Код ошибки неудачного открытия модели по итогу (`OpenResult.state`). */
export function modelOpenFailure(state: string) {
  return state === 'OPEN_STATE_TOO_NEW' ? MODEL_TOO_NEW : 'ERROR_CODE_UNAVAILABLE';
}

/** Ошибка вызова модели: вид `ProtoError` (`{"error": …}`). */
export class ModelError extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}

/** Ошибка действия клиента модели (`clientCall`): строкой — JSON `{"need": …}` либо `{"error": …}`, как прежняя
 * обвязка (`parseEngineError(String(e))`). */
export class EngineCallError extends Error {
  constructor(readonly raw: string) {
    super(raw);
  }

  override toString() {
    return this.raw;
  }
}

/** Отложенная запись состояния модели (как прежний снимок клиента, perf A1). */
const FLUSH_DEBOUNCE_MS = 400;
const FLUSH_MAX_DELAY_MS = 2000;

type EngineLike = {
  call: (name: string, args: string) => string;
  free?: () => void;
};

function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Хост модели движка поверх хранилища и транспорта. */
export class ModelHost {
  private chain: Promise<unknown> = Promise.resolve();

  private closed = false;

  // Обработчик изменений идёт: вызов модели из него встаёт в очередь и не ждётся (иначе взаимная блокировка)
  private inDelta = 0;

  private flushTimer?: ReturnType<typeof setTimeout>;

  private flushFirstAt = 0;

  constructor(private readonly engine: EngineLike, private readonly deps: ModelHostDeps) {}

  /** Открыть модель (`EngineConfig` proto3-JSON): чтение корня и профиля, итог открытия — `deps.onOpen`. */
  static async open(config: ModelJson, deps: ModelHostDeps, engineFactory?: (cfg: string) => EngineLike) {
    const make = engineFactory ?? ((cfg: string) => {
      if (!loaded) throw new Error('движок не загружен');
      return loaded.PvEngine.open(cfg);
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

  /** Вызов модели с выполнением итога; результат — итог (`Outcome`) первого вызова. Из обработчика изменений —
   * в очередь без ожидания (результат — пустой итог). */
  run(name: string, args: unknown): Promise<ModelJson> {
    const queued = this.serial(() => this.drive(this.raw(name, args)));
    if (!this.inDelta) return queued;
    queued.catch((e: unknown) => this.deps.log?.(`модель: ${name} из обработчика: ${String(e)}`));
    return Promise.resolve({});
  }

  /** Вызов строк истории (`rowsApply`, spec 035 T114) с итогом. Из обработчика изменений другого итога — сразу,
   * вложенным обходом: пачка строк (движок кладёт в неё только строки и маркеры) ложится на диск раньше пачки того
   * итога (курсор инбокса после строки, SYNC-1), `storeCommitted` — в очередь за ним (иначе прочее изменённое
   * легло бы раньше его более старой копии). Вне обработчика — в очереди, как `run`. */
  apply(name: string, args: unknown): Promise<ModelJson> {
    if (!this.inDelta) return this.run(name, args);
    return this.driveNested(this.raw(name, args));
  }

  private async driveNested(out: ModelJson): Promise<ModelJson> {
    const delta = out.delta as ModelJson | undefined;
    if (delta && this.deps.onDelta) {
      this.inDelta++;
      try {
        await this.deps.onDelta(delta);
      } catch (e) {
        this.deps.log?.(`модель: изменения не применены хостом: ${String(e)}`);
      } finally {
        this.inDelta--;
      }
    }
    const batch = out.store_batch as ModelJson | undefined;
    if (batch) {
      const typed = storeBatchFromJson(batch);
      await this.deps.store.commit(typed);
      void this.run('storeCommitted', { batch_id: typed.batchId || '0' });
    }
    for (const r of (out.requests as ModelRequest[] | undefined) ?? []) this.deps.send(r);
    // Чтения хранилища у `rowsApply` не бывает (профиль модели в памяти целиком)
    if ((out.store_reads as ModelJson[] | undefined)?.length) this.deps.log?.('модель: чтения во вложенном вызове');
    return out;
  }

  /** Действие или чтение клиентского ядра модели (`clientCall`), синхронно; изменённое ляжет на диск отложенной
   * записью (`flush`). Ошибка — `EngineCallError` с JSON `{"need": …}` / `{"error": …}`. */
  clientCall(name: string, args: Record<string, unknown> = {}): unknown {
    if (this.closed) throw new EngineCallError('{"error":"Closed"}');
    const argsJson = JSON.stringify({ name, args_json: JSON.stringify(args) });
    const out = JSON.parse(this.engine.call('clientCall', argsJson)) as {
      result_json?: string; need?: unknown; error?: unknown;
    };
    if (out.need !== undefined || out.error !== undefined) throw new EngineCallError(JSON.stringify(out));
    this.scheduleFlush();
    return JSON.parse(out.result_json ?? 'null');
  }

  /** Функция сессии журнала истории модели (`historyCall`): результат — JSON-текст, ошибка — исключение. */
  historyCall(name: string, argsJson: string): string {
    const out = JSON.parse(this.engine.call('historyCall', JSON.stringify({ name, args_json: argsJson || '{}' }))) as {
      result_json?: string; need?: unknown; error?: unknown;
    };
    if (out.need !== undefined || out.error !== undefined) throw new EngineCallError(JSON.stringify(out));
    return out.result_json ?? 'null';
  }

  /** Сменить клиент модели: новое устройство либо импорт экспорта (`blob` под `key`). */
  clientReplace(mode: 'new' | 'import', blob?: Uint8Array, key?: Uint8Array) {
    const out = this.raw('clientReplace', {
      mode, blob: blob ? b64(blob) : undefined, key: key ? b64(key) : undefined,
    });
    this.scheduleFlush();
    return out;
  }

  /** Записать изменённое сейчас: на диске до возврата (из обработчика изменений — только в очередь). */
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushFirstAt = 0;
    if (this.closed) return Promise.resolve({});
    return this.run('flush', {});
  }

  /** Перед запросом серверу: отложенное изменённое — на диск (подготовка отправки двигает цепочки ключей Olm, и
   * перезагрузка вкладки после ушедшего запроса, но до отложенной записи, шифровала бы следующее сообщение уже
   * израсходованным звеном — получатель его отвергает). Из обработчика изменений ждать нельзя — только в очередь. */
  flushBeforeSend(): Promise<unknown> {
    if (this.closed || !this.flushTimer) return Promise.resolve();
    if (this.inDelta) {
      void this.flush().catch(() => undefined);
      return Promise.resolve();
    }
    return this.flush();
  }

  /** Записать изменённое отложенно (debounce 400 мс, не дольше 2 с от первого изменения). */
  scheduleFlush() {
    if (this.closed) return;
    const now = Date.now();
    if (!this.flushFirstAt) this.flushFirstAt = now;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const delay = Math.max(0, Math.min(FLUSH_DEBOUNCE_MS, this.flushFirstAt + FLUSH_MAX_DELAY_MS - now));
    this.flushTimer = setTimeout(() => {
      void this.flush().catch((e: unknown) => this.deps.log?.(`модель: отложенная запись: ${String(e)}`));
    }, delay);
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

  /** Запись журнала инбокса (живое уведомление `inbox.record`). */
  ingestRecord(body: Uint8Array) {
    return this.run('ingest', { kind: 'SERVER_INPUT_KIND_INBOX_RECORD', body: b64(body) });
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
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
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
    const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    const out = JSON.parse(this.engine.call(name, argsJson)) as ModelJson;
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
      if (delta && this.deps.onDelta) {
        this.inDelta++;
        try {
          await this.deps.onDelta(delta);
        } catch (e) {
          this.deps.log?.(`модель: изменения не применены хостом: ${String(e)}`);
        } finally {
          this.inDelta--;
        }
      }
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

// ── Модель в памяти: клиент без профиля (тесты, разовые проверки; spec 035 T113/T118) ─────────────────────────
//
// Модель открывается синхронно над пустым хранилищем в памяти (пачки не сохраняются); клиент — её ядро. Снимок
// прежнего клиента (`blob` под `key`) — импортом.

class MemoryCore {
  private closed = false;

  constructor(private readonly engine: EngineLike) {}

  clientCall(name: string, args: Record<string, unknown>): unknown {
    const argsJson = JSON.stringify({ name, args_json: JSON.stringify(args) });
    const out = JSON.parse(this.engine.call('clientCall', argsJson)) as {
      result_json?: string; need?: unknown; error?: unknown;
    };
    if (out.need !== undefined || out.error !== undefined) throw new EngineCallError(JSON.stringify(out));
    return JSON.parse(out.result_json ?? 'null');
  }

  historyCall(name: string, argsJson: string): string {
    const out = JSON.parse(this.engine.call('historyCall', JSON.stringify({ name, args_json: argsJson || '{}' }))) as {
      result_json?: string; need?: unknown; error?: unknown;
    };
    if (out.need !== undefined || out.error !== undefined) throw new EngineCallError(JSON.stringify(out));
    return out.result_json ?? 'null';
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.engine.free?.();
  }
}

/** Клиент модели в памяти (`user`, устройство, домен); `snapshot` — экспорт прежнего клиента. */
export function openMemoryClient(
  user: string, deviceId: string, domain = 'local', snapshot?: { blob: Uint8Array; key: Uint8Array },
): EngineClient {
  const memory = { engine: pv.PvEngine.open(JSON.stringify({
    user,
    device_id: deviceId,
    domain,
    now_ms: String(Date.now()),
    device_key: b64(crypto.getRandomValues(new Uint8Array(32))),
    host_driven: true,
  })) };
  const { engine } = memory;
  const start = JSON.parse(memory.engine.call('start', '{}')) as { store_reads?: { read_id?: string }[] };
  const readId = start.store_reads?.[0]?.read_id ?? '1';
  JSON.parse(memory.engine.call('storeLoaded', JSON.stringify({ read_id: readId, entries: [] })));
  if (snapshot) {
    const out = JSON.parse(memory.engine.call('clientReplace', JSON.stringify({
      mode: 'import', blob: b64(snapshot.blob), key: b64(snapshot.key),
    }))) as { error?: string };
    if (out.error) {
      engine.free();
      throw new EngineCallError(JSON.stringify(out));
    }
  }
  const client = new EngineClient(new MemoryCore(engine));
  client.ownsCore = true;
  return client;
}

// ── Хранилище модели в профиле web (spec 035 T113) ─────────────────────────────────────────────────────────
//
// Модель шифрует свои записи своим DEK; записи лежат в защищённом хранилище профиля (`SecureE2eStorage`) под
// именами `model:<ключ модели>` — поэтому на них действуют PIN, смена поколения и вкладки профиля. Пачка модели —
// одна запись хранилища (записи и удаления вместе).

/** Что модели нужно от защищённого хранилища профиля (`SecureE2eStorage`). */
export interface ModelRecords {
  writeModelRecords(puts: [name: string, bytes: Uint8Array][], deletes: string[]): Promise<unknown>;
  loadModelRecord(name: string): Promise<Uint8Array | undefined>;
  loadModelRecords(prefix: string): Promise<{ name: string; bytes: Uint8Array }[]>;
}

const MODEL_PREFIX = 'model:';

function modelName(key: string) {
  return `${MODEL_PREFIX}${key.replace(/\//g, '~')}`;
}

function modelKey(name: string) {
  return name.slice(MODEL_PREFIX.length).replace(/~/g, '/');
}

/** Хранилище модели поверх записей профиля. */
export function secureModelStore(records: ModelRecords): ModelStore {
  return {
    commit: async (batch) => {
      await records.writeModelRecords(
        batch.puts.map((p) => [modelName(p.key), p.value]),
        batch.deletes.map(modelName),
      );
    },
    read: async (reads) => {
      const out: StorePut[] = [];
      for (const key of reads.keys) {
        const value = await records.loadModelRecord(modelName(key));
        if (value) out.push({ key, value });
      }
      if (reads.prefix) {
        const rows = (await records.loadModelRecords(modelName(reads.prefix)))
          .map((r) => ({ key: modelKey(r.name), value: r.bytes }))
          .filter((r) => r.key.startsWith(reads.prefix) && r.key > reads.after)
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        out.push(...(reads.limit ? rows.slice(0, reads.limit) : rows));
      }
      return out;
    },
  };
}

/** Отправка запросов модели: ответ — `ingestResponse`, учёт запросов в пути (ожидание «всё отвечено»). */
export function createModelSender(
  call: (req: ModelRequest, body: Uint8Array) => Promise<Uint8Array>,
  log: (message: string) => void,
) {
  let inflight = 0;
  let failed = 0;
  let waiters: (() => void)[] = [];
  let host: ModelHost | undefined;
  const settle = () => {
    if (inflight) return;
    const list = waiters;
    waiters = [];
    list.forEach((w) => w());
  };
  return {
    bind(next: ModelHost) {
      host = next;
    },
    send(req: ModelRequest) {
      inflight++;
      void call(req, unb64(req.body))
        .then((resp) => host?.ingestResponse(req.req_id, resp, 0), (e: unknown) => {
          log(`модель: ${req.method}: ${String((e as Error)?.message ?? e)}`);
          failed++;
          return host?.ingestResponse(req.req_id, new Uint8Array(0), errorCodeNumber(e));
        })
        .catch((e: unknown) => log(`модель: ответ ${req.method} не принят: ${String(e)}`))
        .finally(() => {
          inflight--;
          settle();
        });
    },
    /** Все запросы модели отвечены. */
    idle: () => (inflight ? new Promise<void>((resolve) => {
      waiters.push(resolve);
    }) : Promise.resolve()),
    failures: () => failed,
  };
}

export type ModelSender = ReturnType<typeof createModelSender>;

// ── Личное состояние через модель (T114) ──────────────────────────────────────────────────────────────────
//
// Личное состояние (`state.v2`, `state.ops.*`) ведёт модель того же профиля, что и клиентское ядро: сведение,
// метки и разница «желаемое ↔ сведённое» только в движке; сведённое и неотправленное лежат в хранилище модели и
// переживают перезапуск.

/** Показ личного состояния моделью: снимок в форме `state.v1`, избранные стикеры, журнал закрыт для записи. */
export type StateModelView = {
  snapshot: Record<string, unknown>;
  faved_stickers: { set_id: string; sticker_id: string; added_ms: string }[];
  write_blocked: boolean;
};

export type StateModel = {
  view: () => StateModelView;
  /** Желаемое (`state.v1.StateSnapshot`): `kinds` — управляемые виды, `prune` — удалить пропавшие из них,
   * `rewrite` — переписать объекты целиком (новый ключ). Ждёт ответов сервера. */
  apply: (
    desired: unknown, opts?: { kinds?: string[]; prune?: boolean; rewrite?: boolean; base?: unknown },
  ) => Promise<void>;
  submit: (intent: ModelJson) => Promise<void>;
  /** Свои неотправленные — серверу, затем догон журнала до головы. */
  sync: () => Promise<void>;
  /** Изменился показ (свои и чужие операции). */
  onChange: (listener: (() => void) | undefined) => void;
  close: () => void;
};

/** Показ личного состояния модели (то, что уже в её памяти; без сети — сведённое в прошлый раз, T118). */
export function stateViewOf(host: ModelHost): StateModelView {
  return host.peek<StateModelView>('stateViewV1');
}

function unb64(text?: string) {
  if (!text) return new Uint8Array(0);
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

export type StateModelDeps = {
  host: ModelHost;
  sender: ModelSender;
  /** Подписка на изменения личного состояния модели (из общего обработчика изменений хоста). */
  subscribe: (listener: (() => void) | undefined) => void;
};

/** Личное состояние поверх модели профиля. */
export function openStateModel(deps: StateModelDeps): StateModel {
  const { host, sender } = deps;
  let closed = false;
  return {
    view: () => stateViewOf(host),
    apply: async (desired, opts = {}) => {
      const before = sender.failures();
      await host.run('stateApplyV1', {
        snapshot: desired,
        kinds: opts.kinds ?? [],
        prune: Boolean(opts.prune),
        rewrite: Boolean(opts.rewrite),
        base: opts.base,
      });
      await sender.idle();
      if (sender.failures() > before) throw new ModelError('Unavailable');
    },
    submit: async (intent) => {
      const before = sender.failures();
      await host.submit(intent);
      await sender.idle();
      if (sender.failures() > before) throw new ModelError('Unavailable');
    },
    sync: async () => {
      await host.ingestEvent('journal.state');
      await sender.idle();
    },
    onChange: (next) => {
      if (!closed) deps.subscribe(next);
    },
    close: () => {
      closed = true;
      deps.subscribe(undefined);
    },
  };
}
