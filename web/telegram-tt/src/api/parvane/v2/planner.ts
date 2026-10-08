import type { Protocol, PvClient } from './engine';

import { V2Error } from './transport';

// Parvane (spec 010): планировщик на сервере — контейнер домена
// `parvane.planner.v1` (шард domains). Движок держит сведённое состояние,
// ключи эпох и метки; здесь — жизненный цикл: найти/создать контейнер, снимок и
// журнал (`domain.op.sync`), очередь отправки своих операций (переживает
// перезагрузку), пакетирование правок (R4), снимок по порогу (R5), опрос раз в
// 8 с. Статусы для UI: `loading` (стек не поднят), `needs-linking` (устройство
// не в журнале — контейнер не создаём, FR-011), `no-key` (контейнер есть, ключ
// эпохи ещё не пришёл от своих устройств), `offline` (шард недоступен —
// работаем локально), `ready`.

export type PlannerSyncStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';

type Chan = 'id' | 'anon';
type OutReq = { chan: Chan; method: string; body: Uint8Array };

type OutboxItem = { opId: string; op: string };
type ContainerRef = { domain: string; id: string };

type Deps = {
  log: (message: string) => void;
  pv: () => Protocol | undefined;
  client: () => PvClient | undefined;
  isReady: () => boolean;
  needsLinking: () => boolean;
  call: (chan: Chan, method: string, body: Uint8Array) => Promise<Uint8Array>;
  withNeeds: <T>(fn: () => T) => Promise<T>;
  persist: () => Promise<void>;
  loadRecord: <T>(key: string) => Promise<T | undefined>;
  saveRecord: (key: string, value: unknown) => Promise<void>;
  deleteRecord: (key: string) => Promise<void>;
  /** Контейнер из журнала личного состояния (другое устройство уже объявило). */
  stateContainer: () => ContainerRef | undefined;
  /** Объявить контейнер в журнале личного состояния. */
  recordContainer: (ref: ContainerRef) => void;
  /** Состояние или статус изменились — UI перечитает. */
  onChanged: () => void;
};

export const PLANNER_DOMAIN = 'parvane.planner.v1';
const OUTBOX_RECORD = 'planner-outbox';
// Правки, ещё не превращённые в операцию (контейнера нет или идёт пакетирование):
// переживают перезагрузку вкладки, иначе первые правки терялись вместе с ней
const PENDING_RECORD = 'planner-pending';
// Пакетирование правок (R4): тишина, потолок при непрерывном вводе
const FLUSH_IDLE_MS = 1500;
const FLUSH_MAX_MS = 10000;
const SYNC_INTERVAL_MS = 8000;
const RETRY_OFFLINE_MS = 15000;
const SYNC_PAGES = 50;
const MAX_CHANGES_PER_OP = 400;
// Запрос без ответа (обрыв во время setOffline/реконнекта) не должен вешать очередь модуля
const CALL_TIMEOUT_MS = 20000;

function hexToB64(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return btoa(String.fromCharCode(...bytes));
}

function b64ToHex(b64: string) {
  return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function b64ToBytes(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

function errorCode(e: unknown) {
  return e instanceof V2Error ? e.code : undefined;
}

function isUnavailable(e: unknown) {
  const code = errorCode(e);
  return code === 'ERROR_CODE_UNAVAILABLE' || code === 'ERROR_CODE_RATE_LIMITED' || code === undefined;
}

export function createPlannerSync(deps: Deps) {
  let status: PlannerSyncStatus = 'loading';
  let container: ContainerRef | undefined;
  let outbox: OutboxItem[] = [];
  let isOutboxLoaded = false;
  let isPendingLoaded = false;
  let pendingWrite: Promise<void> = Promise.resolve();
  // Правки, ещё не превращённые в операцию (пакетирование)
  let pendingChanges: unknown[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushDeadline: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let isWanted = false;
  let isSnapshotTried = false;
  let lastError: string | undefined;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  function call(chan: Chan, method: string, body: Uint8Array): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new V2Error('ERROR_CODE_UNAVAILABLE')), CALL_TIMEOUT_MS);
      deps.call(chan, method, body).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  function setStatus(next: PlannerSyncStatus) {
    if (status === next) return;
    status = next;
    deps.onChanged();
  }

  function refJson(ref: ContainerRef) {
    return { domain: ref.domain, id: hexToB64(ref.id) };
  }

  // Тело по ИМЕНИ МЕТОДА (кодек реестра): таблица по имени типа новых типов домена не знает
  function encode(method: string, value: unknown) {
    const pv = deps.pv();
    if (!pv) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    return pv.encodeMethodRequest(method, JSON.stringify(value));
  }

  async function loadOutbox() {
    if (isOutboxLoaded) return;
    isOutboxLoaded = true;
    outbox = (await deps.loadRecord<OutboxItem[]>(OUTBOX_RECORD).catch(() => undefined)) || [];
    // Операции очереди уже применены локально до перезагрузки — движок их не
    // помнит (состояние без них в персисте): применить заново (идемпотентно)
    const client = deps.client();
    if (client && client.plannerIsAttached()) {
      outbox.forEach((item) => {
        try {
          client.plannerApplyLocal(b64ToBytes(item.op));
        } catch (e) {
          deps.log(`планировщик: операция из очереди не применена: ${String(e)}`);
        }
      });
    }
  }

  function savePending() {
    const snapshot = pendingChanges.slice();
    pendingWrite = pendingWrite.then(async () => {
      if (snapshot.length) await deps.saveRecord(PENDING_RECORD, snapshot);
      else await deps.deleteRecord(PENDING_RECORD).catch(() => undefined);
    }).catch(() => undefined);
    return pendingWrite;
  }

  async function loadPending() {
    if (isPendingLoaded) return;
    isPendingLoaded = true;
    const saved = (await deps.loadRecord<unknown[]>(PENDING_RECORD).catch(() => undefined)) || [];
    if (!saved.length) return;
    pendingChanges.unshift(...saved);
    deps.log(`планировщик: правок из прошлой сессии ${saved.length}`);
  }

  async function saveOutbox() {
    if (outbox.length) await deps.saveRecord(OUTBOX_RECORD, outbox);
    else await deps.deleteRecord(OUTBOX_RECORD).catch(() => undefined);
  }

  function currentRef(): ContainerRef | undefined {
    const client = deps.client();
    const ref = client?.plannerContainer() as ContainerRef | undefined;
    return ref || container;
  }

  // ── контейнер ──────────────────────────────────────────────────────────────

  /** Найти контейнер: журнал состояния → список на сервере. */
  async function findContainer(): Promise<ContainerRef | undefined> {
    const fromState = deps.stateContainer();
    if (fromState) return fromState;
    const pv = deps.pv();
    if (!pv) return undefined;
    const resp = await call('id', 'domain.container.list', encode(
      'domain.container.list', { domain: PLANNER_DOMAIN },
    ));
    const list = JSON.parse(pv.decodeMethodResponse('domain.container.list', resp)) as {
      containers?: { ref?: { domain?: string; id?: string } }[];
    };
    const first = list.containers?.[0]?.ref;
    if (!first?.domain || !first.id) return undefined;
    return { domain: first.domain, id: b64ToHex(first.id) };
  }

  async function attach(ref: ContainerRef) {
    const client = deps.client();
    if (!client) return;
    const [got, grants] = await Promise.all([
      call('id', 'domain.container.get', encode('domain.container.get', { container: refJson(ref) })),
      call('id', 'domain.grant.list', encode(
        'domain.grant.list', { container: refJson(ref), after_version: '0' },
      )),
    ]);
    client.plannerAttach(got, grants);
    container = ref;
    isSnapshotTried = false;
    deps.recordContainer(ref);
    await deps.persist();
    deps.log(`планировщик: контейнер подключён (${ref.id.slice(0, 8)}…)`);
  }

  async function create() {
    const client = deps.client();
    if (!client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const req = client.plannerCreate(Date.now()) as OutReq;
    await call(req.chan, req.method, req.body);
    container = client.plannerContainer() as ContainerRef;
    deps.recordContainer(container);
    await deps.persist();
    deps.log(`планировщик: контейнер создан (${container.id.slice(0, 8)}…)`);
    await shareKeys();
  }

  async function shareKeys() {
    const client = deps.client();
    if (!client) return;
    try {
      const reqs = await deps.withNeeds(() => client.sharePlannerWithOwnDevices() as OutReq[]);
      for (const r of reqs) await call(r.chan, r.method, r.body);
      if (reqs.length) deps.log('планировщик: ключ контейнера передан своим устройствам');
    } catch (e) {
      deps.log(`планировщик: ключ своим устройствам не передан: ${String(e)}`);
    }
  }

  /** Контейнер подключён (найден или создан по требованию). */
  async function ensureAttached(createIfMissing: boolean): Promise<boolean> {
    const client = deps.client();
    if (!client || !deps.isReady()) {
      deps.log(`планировщик: стек не готов (движок ${client ? 'есть' : 'нет'}, `
        + `линковка ${deps.needsLinking() ? 'нужна' : 'не нужна'})`);
      setStatus(deps.needsLinking() ? 'needs-linking' : 'loading');
      return false;
    }
    if (client.plannerIsAttached()) return true;
    const ref = await findContainer();
    if (ref) {
      await attach(ref);
      return true;
    }
    if (!createIfMissing) {
      deps.log('планировщик: контейнера у аккаунта нет — создастся первой правкой');
      return false;
    }
    await create();
    return true;
  }

  // ── журнал и снимок ────────────────────────────────────────────────────────

  async function pullGrants(ref: ContainerRef) {
    const client = deps.client()!;
    const resp = await call('id', 'domain.grant.list', encode(
      'domain.grant.list', { container: refJson(ref), after_version: '0' },
    ));
    client.plannerIngestGrants(resp);
  }

  async function pull(): Promise<boolean> {
    const client = deps.client();
    const ref = currentRef();
    if (!client || !ref || !client.plannerIsAttached()) return false;
    let changed = false;
    if (!isSnapshotTried && client.plannerHeadSeq() === 0 && client.plannerHasKey()) {
      isSnapshotTried = true;
      const resp = await call('id', 'domain.snapshot.get', encode(
        'domain.snapshot.get', { container: refJson(ref) },
      ));
      const before = client.plannerHeadSeq();
      try {
        if (client.plannerIngestSnapshot(resp) !== before) {
          changed = true;
          // Состояние из снимка — на экран сразу, догон журнала после него — следом (R5, T028)
          deps.log(`планировщик: снимок применён (seq ${client.plannerHeadSeq()})`);
          deps.onChanged();
        }
      } catch (e) {
        deps.log(`планировщик: снимок не прочитан: ${String(e)}`);
      }
    }
    let missingKey = false;
    for (let page = 0; page < SYNC_PAGES; page++) {
      const resp = await call('id', 'domain.op.sync', encode(
        'domain.op.sync', { container: refJson(ref), after_seq: String(client.plannerHeadSeq()), max_bytes: 0 },
      ));
      const r = client.plannerIngestSync(resp) as {
        applied: number; headSeq: number; more: boolean; missingEpoch?: number; grantsBehind: boolean;
      };
      if (r.applied) changed = true;
      if (r.missingEpoch !== undefined) missingKey = true;
      if (r.grantsBehind) {
        await pullGrants(ref);
        continue;
      }
      if (!r.more) break;
    }
    setStatus(missingKey || !client.plannerHasKey() ? 'no-key' : 'ready');
    if (changed) deps.log(`планировщик: журнал применён (seq ${client.plannerHeadSeq()})`);
    return changed;
  }

  async function maybeSnapshot() {
    const client = deps.client();
    if (!client || !client.plannerHasKey()) return;
    try {
      const req = client.plannerSnapshotRequest(Date.now()) as OutReq | undefined;
      if (!req) return;
      await call(req.chan, req.method, req.body);
      deps.log(`планировщик: снимок записан (seq ${client.plannerHeadSeq()})`);
    } catch (e) {
      deps.log(`планировщик: снимок не записан: ${String(e)}`);
    }
  }

  // ── своя очередь ───────────────────────────────────────────────────────────

  /** Накопленные правки → одна операция движка (метки) → очередь отправки. */
  async function prepareLocal() {
    const client = deps.client();
    if (!client && pendingChanges.length) deps.log('планировщик: движка нет — правки ждут');
    if (!client || !pendingChanges.length) return;
    if (!client.plannerIsAttached()) {
      // Первая правка без контейнера: создать (непривязанное устройство сюда не попадает)
      if (!(await ensureAttached(true))) return;
    }
    await loadOutbox();
    const changes = pendingChanges;
    pendingChanges = [];
    void savePending();
    for (let i = 0; i < changes.length; i += MAX_CHANGES_PER_OP) {
      const chunk = changes.slice(i, i + MAX_CHANGES_PER_OP);
      try {
        const local = client.plannerPrepareLocal(JSON.stringify({ changes: chunk })) as {
          opId: string; op: Uint8Array; applied: number;
        };
        outbox.push({ opId: local.opId, op: bytesToB64(local.op) });
      } catch (e) {
        deps.log(`планировщик: правка отвергнута движком: ${String(e)}`);
      }
    }
    await saveOutbox();
    await deps.persist();
  }

  async function sendOutbox() {
    const client = deps.client();
    if (!client || !client.plannerIsAttached()) return;
    await loadOutbox();
    while (outbox.length) {
      const item = outbox[0];
      if (!client.plannerHasKey()) {
        setStatus('no-key');
        return;
      }
      try {
        const req = client.plannerSeal(b64ToBytes(item.op), item.opId, Date.now()) as OutReq;
        await call(req.chan, req.method, req.body);
      } catch (e) {
        const code = errorCode(e);
        if (code === 'ERROR_CODE_DUPLICATE') {
          // Уже принято до обрыва — считаем отправленным
        } else if (code === 'ERROR_CODE_EXPIRED') {
          // Эпоха сменилась другим устройством: догнать гранты, ключ придёт по E2E
          const ref = currentRef();
          if (ref) await pullGrants(ref);
          if (!client.plannerHasKey()) {
            setStatus('no-key');
            return;
          }
          continue;
        } else {
          lastError = String(e);
          setStatus(isUnavailable(e) ? 'offline' : status);
          scheduleRetry();
          return;
        }
      }
      outbox.shift();
      await saveOutbox();
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void syncNow();
    }, RETRY_OFFLINE_MS);
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushNow();
    }, FLUSH_IDLE_MS);
    if (!flushDeadline) {
      flushDeadline = setTimeout(() => {
        flushDeadline = undefined;
        void flushNow();
      }, FLUSH_MAX_MS);
    }
  }

  function clearFlushTimers() {
    if (flushTimer) clearTimeout(flushTimer);
    if (flushDeadline) clearTimeout(flushDeadline);
    flushTimer = undefined;
    flushDeadline = undefined;
  }

  /** Своя правка — в операцию и на сервер. */
  function flushNow() {
    clearFlushTimers();
    return serial(async () => {
      try {
        await prepareLocal();
        await sendOutbox();
        await maybeSnapshot();
      } catch (e) {
        lastError = String(e);
        deps.log(`планировщик: отправка не удалась: ${String(e)}`);
        if (isUnavailable(e)) {
          setStatus('offline');
          scheduleRetry();
        }
      }
      deps.onChanged();
    });
  }

  /** Своя правка — сначала в журнал, затем чужие записи (иначе снимок откатит её). */
  function syncNow() {
    return serial(async () => {
      try {
        // Накопленные правки уходят и отсюда: периодический синк не должен ни
        // отменять таймер пакета, ни оставлять пакет без контейнера
        const hasPendingChanges = pendingChanges.length > 0;
        if (hasPendingChanges) clearFlushTimers();
        if (!(await ensureAttached(hasPendingChanges))) {
          deps.onChanged();
          return;
        }
        await prepareLocal();
        await sendOutbox();
        const changed = await pull();
        await maybeSnapshot();
        await deps.persist();
        if (changed) deps.onChanged();
      } catch (e) {
        lastError = String(e);
        deps.log(`планировщик: синхронизация: ${String(e)}`);
        if (isUnavailable(e)) {
          setStatus('offline');
          scheduleRetry();
        }
      }
      deps.onChanged();
    });
  }

  function startTimers() {
    if (syncTimer) return;
    syncTimer = setInterval(() => {
      void syncNow();
    }, SYNC_INTERVAL_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        if (pendingChanges.length) void flushNow();
      });
    }
  }

  // ── API ────────────────────────────────────────────────────────────────────

  /** UI открыл планировщик: подключить контейнер и синхронизировать. */
  async function ensure() {
    isWanted = true;
    startTimers();
    const client = deps.client();
    deps.log(`планировщик: запуск (контейнер ${client?.plannerIsAttached() ? 'есть' : 'нет'}, `
      + `ключ ${client?.plannerHasKey() ? 'есть' : 'нет'}, seq ${client?.plannerHeadSeq() ?? 0})`);
    await loadPending();
    await syncNow();
  }

  /** Правки планировщика (JSON изменений для движка): применяются локально
   * пакетом, уходят одной операцией по тишине 1,5 с (R4). */
  function apply(changes: unknown[]) {
    if (!changes.length) return;
    pendingChanges.push(...changes);
    void savePending();
    // Без контейнера не ждём тишины: первая правка создаёт его сразу
    if (pendingChanges.length >= MAX_CHANGES_PER_OP || !deps.client()?.plannerIsAttached()) {
      void flushNow();
      return;
    }
    scheduleFlush();
  }

  /** Все накопленные правки — немедленно (перенос данных этапа 1). */
  function flush() {
    return flushNow();
  }

  function stateJson(): string | undefined {
    return deps.client()?.plannerStateJson();
  }

  function currentStatus(): PlannerSyncStatus {
    const client = deps.client();
    if (!client || !deps.isReady()) return deps.needsLinking() ? 'needs-linking' : 'loading';
    if (!client.plannerIsAttached()) return status === 'offline' ? 'offline' : 'ready';
    if (!client.plannerHasKey()) return 'no-key';
    return status === 'loading' || status === 'needs-linking' ? 'ready' : status;
  }

  function keysExport(): string | undefined {
    return deps.client()?.plannerKeysExport();
  }

  function keysImport(json: string) {
    try {
      deps.client()?.plannerKeysImport(json);
    } catch (e) {
      deps.log(`планировщик: ключи из экспорта линковки не приняты: ${String(e)}`);
    }
  }

  /** Событие движка `plannerChanged` (ключ принят / контейнер надо подключить). */
  function onEngineEvent() {
    if (!isWanted) return;
    void syncNow();
  }

  function reset() {
    clearFlushTimers();
    if (syncTimer) clearInterval(syncTimer);
    if (retryTimer) clearTimeout(retryTimer);
    syncTimer = undefined;
    retryTimer = undefined;
    status = 'loading';
    container = undefined;
    outbox = [];
    isOutboxLoaded = false;
    isPendingLoaded = false;
    pendingChanges = [];
    isWanted = false;
    isSnapshotTried = false;
    lastError = undefined;
  }

  return {
    ensure,
    apply,
    flush,
    syncNow,
    stateJson,
    status: currentStatus,
    lastError: () => lastError,
    sizeBytes: () => deps.client()?.plannerSize() ?? 0,
    // Правки, ещё не превращённые в операцию: состояние движка их не содержит —
    // UI не должен затирать ими свой черновик
    hasPending: () => pendingChanges.length > 0,
    keysExport,
    keysImport,
    onEngineEvent,
    reset,
  };
}

export type PlannerSync = ReturnType<typeof createPlannerSync>;
