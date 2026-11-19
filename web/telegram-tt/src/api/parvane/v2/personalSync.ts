import type { Protocol, PvClient } from './engine';
import type { PersonalKind } from './engineClient';

import { isTimerSyncMode, pollDelay } from './l2';
import { V2Error } from './transport';

// Parvane (spec 010, 038): личный контейнер домена на сервере (шард domains) — «План» (`parvane.planner.v1`)
// и «Здоровье» (`parvane.health.v1`); вид задаёт `PersonalSpec` (`planner.ts`, `health.ts`). Движок держит
// сведённое состояние, ключи эпох и метки; здесь — жизненный цикл: найти/создать контейнер, снимок и
// журнал (`domain.op.sync`), очередь отправки своих операций (переживает
// перезагрузку), пакетирование правок (R4), снимок по порогу (R5), опрос раз в
// 8 с, пока раздел кому-то нужен и вкладка видна (иначе раз в 60 с; при возврате
// — сразу). Персист и событие для UI — только когда состояние менялось.
// Статусы для UI: `loading` (стек не поднят), `needs-linking` (устройство
// не в журнале — контейнер не создаём, FR-011), `no-key` (контейнер есть, ключ
// эпохи ещё не пришёл от своих устройств), `offline` (шард недоступен —
// работаем локально), `ready`.

export type PersonalSyncStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';

type Chan = 'id' | 'anon';
type OutReq = { chan: Chan; method: string; body: Uint8Array; dest?: string };

// `ids` — записи, которые несёт операция (пометка «не отправлено» у записи, spec 041 E6); у очереди прежних
// версий поля нет
type OutboxItem = { opId: string; op: string; ids?: string[] };
// Повторов отправки одной операции после EXPIRED за проход (сервер, всегда отвечающий EXPIRED, не держит цикл вечно)
const SEND_EXPIRED_RETRIES = 3;
type ContainerRef = { domain: string; id: string };

export type PersonalDeps = {
  log: (message: string) => void;
  pv: () => Protocol | undefined;
  client: () => PvClient | undefined;
  isReady: () => boolean;
  needsLinking: () => boolean;
  // dest — сервер объекта (spec 028)
  call: (chan: Chan, method: string, body: Uint8Array, dest?: string) => Promise<Uint8Array>;
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

// Правки, ещё не превращённые в операцию (контейнера нет или идёт пакетирование):
// переживают перезагрузку вкладки, иначе первые правки терялись вместе с ней
// — запись `<вид>-pending` хранилища устройства
// Пакетирование правок (R4): тишина, потолок при непрерывном вводе
const FLUSH_IDLE_MS = 1500;
const FLUSH_MAX_MS = 10000;
const SYNC_INTERVAL_MS = 8000;
// Раздел закрыт либо вкладка скрыта: опрос редкий (правки уходят своими таймерами)
const SYNC_IDLE_MS = 60000;
const RETRY_OFFLINE_MS = 15000;
const SYNC_PAGES = 50;
const MAX_CHANGES_PER_OP = 400;
// Запрос без ответа (обрыв во время setOffline/реконнекта) не должен вешать очередь модуля
const CALL_TIMEOUT_MS = 20000;

// Правка — `{ <вид>: { id, … } }`: id записи; у правок без id (настройки) записи нет
function collectChangeIds(changes: unknown[]) {
  return changes.flatMap((change) => {
    const body = change && typeof change === 'object' ? Object.values(change)[0] as unknown : undefined;
    const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id ? [id] : [];
  });
}

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

/** Личный контейнер домена: какой вид, как называются его записи на устройстве и как сжимать правки. */
export type PersonalSpec = {
  kind: PersonalKind;
  domain: string;
  // Подпись в журнале отладки
  label: string;
  outboxRecord: string;
  pendingRecord: string;
  // Сжать накопленные правки перед операцией (правки одного объекта — в одну)
  coalesce: (changes: unknown[]) => unknown[];
};

export function createPersonalSync(deps: PersonalDeps, spec: PersonalSpec) {
  let status: PersonalSyncStatus = 'loading';
  let container: ContainerRef | undefined;
  let outbox: OutboxItem[] = [];
  let isOutboxLoaded = false;
  let isPendingLoaded = false;
  let pendingWrite: Promise<void> = Promise.resolve();
  // Правки, ещё не превращённые в операцию (пакетирование)
  let pendingChanges: unknown[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let flushDeadline: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let isWanted = false;
  // Есть потребители состояния (раздел, палитра, карточки задания в чате): частый опрос
  let isActive = true;
  // Запущен только фоном (напоминания): первый вызов из UI возвращает частый опрос
  let isBackgroundOnly = false;
  let isSnapshotTried = false;
  let isNoContainerAnnounced = false;
  let areListenersSet = false;
  let lastError: string | undefined;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  function call(chan: Chan, method: string, body: Uint8Array, dest?: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new V2Error('ERROR_CODE_UNAVAILABLE')), CALL_TIMEOUT_MS);
      deps.call(chan, method, body, dest).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  function setStatus(next: PersonalSyncStatus) {
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
    outbox = (await deps.loadRecord<OutboxItem[]>(spec.outboxRecord).catch(() => undefined)) || [];
    // Операции очереди уже применены локально до перезагрузки — движок их не
    // помнит (состояние без них в персисте): применить заново (идемпотентно)
    const client = deps.client();
    if (client && client.personal(spec.kind).isAttached()) {
      outbox.forEach((item) => {
        try {
          client.personal(spec.kind).applyLocal(b64ToBytes(item.op));
        } catch (e) {
          deps.log(`${spec.label}: операция из очереди не применена: ${String(e)}`);
        }
      });
    }
  }

  function savePending() {
    const snapshot = pendingChanges.slice();
    pendingWrite = pendingWrite.then(async () => {
      if (snapshot.length) await deps.saveRecord(spec.pendingRecord, snapshot);
      else await deps.deleteRecord(spec.pendingRecord).catch(() => undefined);
    }).catch(() => undefined);
    return pendingWrite;
  }

  async function loadPending() {
    if (isPendingLoaded) return;
    isPendingLoaded = true;
    const saved = (await deps.loadRecord<unknown[]>(spec.pendingRecord).catch(() => undefined)) || [];
    if (!saved.length) return;
    pendingChanges.unshift(...saved);
    deps.log(`${spec.label}: правок из прошлой сессии ${saved.length}`);
  }

  async function saveOutbox() {
    if (outbox.length) await deps.saveRecord(spec.outboxRecord, outbox);
    else await deps.deleteRecord(spec.outboxRecord).catch(() => undefined);
  }

  function currentRef(): ContainerRef | undefined {
    const client = deps.client();
    const ref = client?.personal(spec.kind).container() as ContainerRef | undefined;
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
      'domain.container.list', { domain: spec.domain },
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
    client.personal(spec.kind).attach(got, grants);
    container = ref;
    isSnapshotTried = false;
    deps.recordContainer(ref);
    await deps.persist();
    deps.log(`${spec.label}: контейнер подключён (${ref.id.slice(0, 8)}…)`);
  }

  async function create() {
    const client = deps.client();
    if (!client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const req = client.personal(spec.kind).create(Date.now()) as OutReq;
    await call(req.chan, req.method, req.body, req.dest);
    container = client.personal(spec.kind).container() as ContainerRef;
    deps.recordContainer(container);
    await deps.persist();
    deps.log(`${spec.label}: контейнер создан (${container.id.slice(0, 8)}…)`);
    await shareKeys();
  }

  async function shareKeys() {
    const client = deps.client();
    if (!client) return;
    try {
      const reqs = await deps.withNeeds(() => client.personal(spec.kind).shareWithOwnDevices() as OutReq[]);
      for (const r of reqs) await call(r.chan, r.method, r.body, r.dest);
      if (reqs.length) deps.log(`${spec.label}: ключ контейнера передан своим устройствам`);
    } catch (e) {
      deps.log(`${spec.label}: ключ своим устройствам не передан: ${String(e)}`);
    }
  }

  /** Контейнер подключён (найден или создан по требованию). */
  async function ensureAttached(createIfMissing: boolean): Promise<boolean> {
    const client = deps.client();
    if (!client || !deps.isReady()) {
      deps.log(`${spec.label}: стек не готов (движок ${client ? 'есть' : 'нет'}, `
        + `линковка ${deps.needsLinking() ? 'нужна' : 'не нужна'})`);
      setStatus(deps.needsLinking() ? 'needs-linking' : 'loading');
      return false;
    }
    if (client.personal(spec.kind).isAttached()) return true;
    const ref = await findContainer();
    if (ref) {
      await attach(ref);
      return true;
    }
    if (!createIfMissing) {
      deps.log(`${spec.label}: контейнера у аккаунта нет — создастся первой правкой`);
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
    client.personal(spec.kind).ingestGrants(resp);
  }

  async function pull(): Promise<boolean> {
    const client = deps.client();
    const ref = currentRef();
    if (!client || !ref || !client.personal(spec.kind).isAttached()) return false;
    let changed = false;
    if (!isSnapshotTried && client.personal(spec.kind).headSeq() === 0 && client.personal(spec.kind).hasKey()) {
      isSnapshotTried = true;
      const resp = await call('id', 'domain.snapshot.get', encode(
        'domain.snapshot.get', { container: refJson(ref) },
      ));
      const before = client.personal(spec.kind).headSeq();
      try {
        if (client.personal(spec.kind).ingestSnapshot(resp) !== before) {
          changed = true;
          // Состояние из снимка — на экран сразу, догон журнала после него — следом (R5, T028)
          deps.log(`${spec.label}: снимок применён (seq ${client.personal(spec.kind).headSeq()})`);
          deps.onChanged();
        }
      } catch (e) {
        deps.log(`${spec.label}: снимок не прочитан: ${String(e)}`);
      }
    }
    let missingKey = false;
    for (let page = 0; page < SYNC_PAGES; page++) {
      const resp = await call('id', 'domain.op.sync', encode(
        'domain.op.sync',
        { container: refJson(ref), after_seq: String(client.personal(spec.kind).headSeq()), max_bytes: 0 },
      ));
      const r = client.personal(spec.kind).ingestSync(resp) as {
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
    setStatus(missingKey || !client.personal(spec.kind).hasKey() ? 'no-key' : 'ready');
    if (changed) deps.log(`${spec.label}: журнал применён (seq ${client.personal(spec.kind).headSeq()})`);
    return changed;
  }

  /** Снимок по порогу; `true` — записан (движок запомнил его seq — нужен персист). */
  async function maybeSnapshot(): Promise<boolean> {
    const client = deps.client();
    if (!client || !client.personal(spec.kind).hasKey()) return false;
    try {
      const req = client.personal(spec.kind).snapshotRequest(Date.now()) as OutReq | undefined;
      if (!req) return false;
      await call(req.chan, req.method, req.body, req.dest);
      deps.log(`${spec.label}: снимок записан (seq ${client.personal(spec.kind).headSeq()})`);
      return true;
    } catch (e) {
      deps.log(`${spec.label}: снимок не записан: ${String(e)}`);
      return false;
    }
  }

  // ── своя очередь ───────────────────────────────────────────────────────────

  /** Накопленные правки → одна операция движка (метки) → очередь отправки.
   * Возвращает число подготовленных операций (состояние движка изменилось). */
  async function prepareLocal(): Promise<number> {
    const client = deps.client();
    if (!client && pendingChanges.length) deps.log(`${spec.label}: движка нет — правки ждут`);
    if (!client || !pendingChanges.length) return 0;
    if (!client.personal(spec.kind).isAttached()) {
      // Первая правка без контейнера: создать (непривязанное устройство сюда не попадает)
      if (!(await ensureAttached(true))) return 0;
    }
    await loadOutbox();
    // Одна операция — одна метка: правки одного объекта склеиваются, иначе поздняя могла проиграть ранней
    const changes = spec.coalesce(pendingChanges);
    pendingChanges = [];
    void savePending();
    let prepared = 0;
    for (let i = 0; i < changes.length; i += MAX_CHANGES_PER_OP) {
      const chunk = changes.slice(i, i + MAX_CHANGES_PER_OP);
      try {
        const local = client.personal(spec.kind).prepareLocal(JSON.stringify({ changes: chunk })) as {
          opId: string; op: Uint8Array; applied: number;
        };
        outbox.push({ opId: local.opId, op: bytesToB64(local.op), ids: collectChangeIds(chunk) });
        prepared += 1;
      } catch (e) {
        deps.log(`${spec.label}: правка отвергнута движком: ${String(e)}`);
      }
    }
    await saveOutbox();
    await deps.persist();
    return prepared;
  }

  async function sendOutbox() {
    const client = deps.client();
    if (!client || !client.personal(spec.kind).isAttached()) return;
    await loadOutbox();
    // Повторы после EXPIRED на одну операцию за проход: сервер, всегда отвечающий EXPIRED, не должен держать цикл вечно
    let expiredRetries = 0;
    let expiredOpId = '';
    while (outbox.length) {
      const item = outbox[0];
      if (item.opId !== expiredOpId) {
        expiredOpId = item.opId;
        expiredRetries = 0;
      }
      if (!client.personal(spec.kind).hasKey()) {
        setStatus('no-key');
        return;
      }
      try {
        const req = client.personal(spec.kind).seal(b64ToBytes(item.op), item.opId, Date.now()) as OutReq;
        await call(req.chan, req.method, req.body, req.dest);
      } catch (e) {
        const code = errorCode(e);
        if (code === 'ERROR_CODE_DUPLICATE') {
          // Уже принято до обрыва — считаем отправленным
        } else if (code === 'ERROR_CODE_EXPIRED' && expiredRetries < SEND_EXPIRED_RETRIES) {
          expiredRetries += 1;
          // Эпоха сменилась другим устройством: догнать гранты, ключ придёт по E2E
          const ref = currentRef();
          if (ref) await pullGrants(ref);
          if (!client.personal(spec.kind).hasKey()) {
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
      // Запись ушла: экраны снимают с неё пометку «не отправлено»
      if (!outbox.length) deps.onChanged();
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
      let changed = false;
      try {
        changed = (await prepareLocal()) > 0;
        await sendOutbox();
        if (await maybeSnapshot()) await deps.persist();
      } catch (e) {
        if (lastError !== String(e)) changed = true;
        lastError = String(e);
        deps.log(`${spec.label}: отправка не удалась: ${String(e)}`);
        if (isUnavailable(e)) {
          setStatus('offline');
          scheduleRetry();
        }
      }
      // Состояние движка менялось только подготовленными правками (и ошибка нужна экрану)
      if (changed) deps.onChanged();
    });
  }

  /** Своя правка — сначала в журнал, затем чужие записи (иначе снимок откатит её). */
  function syncNow() {
    return serial(async () => {
      let changed = false;
      try {
        // Накопленные правки уходят и отсюда: периодический синк не должен ни
        // отменять таймер пакета, ни оставлять пакет без контейнера
        const hasPendingChanges = pendingChanges.length > 0;
        if (hasPendingChanges) clearFlushTimers();
        if (!(await ensureAttached(hasPendingChanges))) {
          // Контейнера нет (создастся первой правкой): экрану это сообщается один
          // раз, иначе каждый опрос перерисовывал бы всех подписчиков
          if (!isNoContainerAnnounced) {
            isNoContainerAnnounced = true;
            deps.onChanged();
          }
          return;
        }
        if ((await prepareLocal()) > 0) changed = true;
        await sendOutbox();
        if (await pull()) changed = true;
        const isSnapshotWritten = await maybeSnapshot();
        // Персист — только когда движок что-то менял; иначе каждые 8 с на диск
        // уходило бы полное состояние без изменений
        if (changed || isSnapshotWritten) await deps.persist();
      } catch (e) {
        // Новая ошибка нужна экрану; та же самая при каждом опросе — нет
        if (lastError !== String(e)) changed = true;
        lastError = String(e);
        deps.log(`${spec.label}: синхронизация: ${String(e)}`);
        if (isUnavailable(e)) {
          setStatus('offline');
          scheduleRetry();
        }
      } finally {
        scheduleSync();
      }
      if (changed) deps.onChanged();
    });
  }

  function isHidden() {
    return typeof document !== 'undefined' && document.hidden;
  }

  /** Следующий опрос: частый, пока есть потребители и вкладка видна, иначе редкий. */
  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = undefined;
    if (!isWanted) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void syncNow();
    }, pollDelay(SYNC_INTERVAL_MS, SYNC_IDLE_MS, isActive && !isHidden()));
  }

  function startTimers() {
    scheduleSync();
    if (areListenersSet || typeof window === 'undefined') return;
    areListenersSet = true;
    window.addEventListener('pagehide', () => {
      if (pendingChanges.length) void flushNow();
    });
    document.addEventListener('visibilitychange', () => {
      if (!isWanted) return;
      // Вкладка снова видна: догнать сразу, дальше — по обычному расписанию
      if (!document.hidden && isActive && !isTimerSyncMode()) void syncNow();
      else scheduleSync();
    });
  }

  // ── API ────────────────────────────────────────────────────────────────────

  /** UI открыл ${spec.label}: подключить контейнер и синхронизировать. `isBackground` — запуск без потребителей
   * (напоминания): опрос редкий, пока UI сам не позовёт `ensure`; уже запущенный планировщик он не трогает. */
  async function ensure(isBackground = false) {
    if (isBackground) {
      if (isWanted) return;
      isActive = false;
      isBackgroundOnly = true;
    } else if (isBackgroundOnly) {
      isBackgroundOnly = false;
      isActive = true;
    }
    isWanted = true;
    startTimers();
    const client = deps.client();
    deps.log(`${spec.label}: запуск (контейнер ${client?.personal(spec.kind).isAttached() ? 'есть' : 'нет'}, `
      + `ключ ${client?.personal(spec.kind).hasKey() ? 'есть' : 'нет'}, `
      + `seq ${client?.personal(spec.kind).headSeq() ?? 0})`);
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
    if (pendingChanges.length >= MAX_CHANGES_PER_OP || !deps.client()?.personal(spec.kind).isAttached()) {
      void flushNow();
      return;
    }
    scheduleFlush();
  }

  /** Все накопленные правки — немедленно (перенос данных этапа 1). */
  function flush() {
    return flushNow();
  }

  /** Есть ли потребители состояния (раздел «План», палитра, карточки задания в
   * чате): без них опрос редкий, с первым — немедленный синк. */
  function setActive(active: boolean) {
    isBackgroundOnly = false;
    if (isActive === active) return;
    isActive = active;
    if (!isWanted) return;
    if (active && !isHidden() && !isTimerSyncMode()) void syncNow();
    else scheduleSync();
  }

  function stateJson(): string | undefined {
    return deps.client()?.personal(spec.kind).stateJson();
  }

  function currentStatus(): PersonalSyncStatus {
    const client = deps.client();
    if (!client || !deps.isReady()) return deps.needsLinking() ? 'needs-linking' : 'loading';
    if (!client.personal(spec.kind).isAttached()) return status === 'offline' ? 'offline' : 'ready';
    if (!client.personal(spec.kind).hasKey()) return 'no-key';
    return status === 'loading' || status === 'needs-linking' ? 'ready' : status;
  }

  function keysExport(): string | undefined {
    return deps.client()?.personal(spec.kind).keysExport();
  }

  function keysImport(json: string) {
    try {
      deps.client()?.personal(spec.kind).keysImport(json);
    } catch (e) {
      deps.log(`${spec.label}: ключи из экспорта линковки не приняты: ${String(e)}`);
      return;
    }
    // Ключ есть — подключаем «План» сразу, а не на следующем опросе (до минуты в фоне)
    if (isWanted) void syncNow();
  }

  /** Событие движка `plannerChanged` (ключ принят / контейнер надо подключить). */
  function onEngineEvent() {
    if (!isWanted) return;
    void syncNow();
  }

  function reset() {
    clearFlushTimers();
    if (syncTimer) clearTimeout(syncTimer);
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
    isActive = true;
    isBackgroundOnly = false;
    isSnapshotTried = false;
    isNoContainerAnnounced = false;
    lastError = undefined;
  }

  return {
    ensure,
    setActive,
    apply,
    flush,
    syncNow,
    stateJson,
    status: currentStatus,
    lastError: () => lastError,
    sizeBytes: () => deps.client()?.personal(spec.kind).size() ?? 0,
    // Правки, ещё не превращённые в операцию: состояние движка их не содержит —
    // UI не должен затирать ими свой черновик
    hasPending: () => pendingChanges.length > 0,
    // Записи с правками, которые ещё не приняты сервером: и копящиеся, и операции очереди
    unsentIds: () => [...collectChangeIds(pendingChanges), ...outbox.flatMap((item) => item.ids || [])],
    keysExport,
    keysImport,
    onEngineEvent,
    reset,
  };
}

export type PersonalSync = ReturnType<typeof createPersonalSync>;
