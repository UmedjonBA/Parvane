import type { Protocol, PvClient } from './engine';

import { V2Error } from './transport';

// Parvane (spec 016): раздел «Облако» — контейнеры домена `cloud.v1` (шард
// domains): личный диск и совместные папки, свои и чужие. Движок держит дерево,
// ключи эпох, журнал грантов и метки; здесь — жизненный цикл: найти контейнеры
// (журнал личного состояния + `domain.container.list`), подключить, снимок и
// журнал (`domain.op.sync`), очередь отправки своих операций (переживает
// перезагрузку), снимок по порогу, опрос (8 с при открытом разделе, 60 с в
// фоне), доступ участников, сборка блобов стёртых файлов. Статусы для UI — как
// у планировщика: `loading`, `needs-linking` (диск не создаём), `no-key`,
// `offline`, `ready`.

export type CloudSyncStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';
export type CloudContainerKind = 'root' | 'owned' | 'shared' | 'invite';
export type CloudRole = 'owner' | 'editor' | 'reader';

export type CloudContainerInfo = {
  id: string;
  kind: CloudContainerKind;
  role?: CloudRole;
  owner: string;
  name: string;
  hasKey: boolean;
  members: { user: string; role: CloudRole }[];
};

/** Запись журнала личного состояния о контейнере облака (id — hex). */
export type CloudStateEntry = {
  id: string;
  domain: string;
  role: 'root' | 'owned' | 'shared';
  status?: 'accepted' | 'declined';
  isRemoved?: boolean;
  owner?: string;
};

type Chan = 'id' | 'anon';
type OutReq = { chan: Chan; method: string; body: Uint8Array };
type OutboxItem = { opId: string; op: string };

type EngineContainer = {
  id: string;
  owner: string;
  role?: CloudRole;
  name: string;
  hasKey: boolean;
  headSeq: number;
  epoch: number;
  grantVersion: number;
  members: { user: string; role: CloudRole }[];
};

type Deps = {
  log: (message: string) => void;
  pv: () => Protocol | undefined;
  client: () => PvClient | undefined;
  isReady: () => boolean;
  needsLinking: () => boolean;
  self: () => string | undefined;
  serverDomain: () => string | undefined;
  call: (chan: Chan, method: string, body: Uint8Array) => Promise<Uint8Array>;
  withNeeds: <T>(fn: () => T) => Promise<T>;
  /** Перечитать журнал устройств собеседника (новое устройство участника). */
  refreshPeerLog: (user: string) => Promise<void>;
  persist: () => Promise<void>;
  loadRecord: <T>(key: string) => Promise<T | undefined>;
  saveRecord: (key: string, value: unknown) => Promise<void>;
  deleteRecord: (key: string) => Promise<void>;
  /** Контейнеры облака из журнала личного состояния. */
  stateEntries: () => CloudStateEntry[];
  /** Записать контейнер в журнал личного состояния. */
  recordEntry: (entry: CloudStateEntry) => void;
  /** Стереть свой блоб на сервере (файл удалён из облака окончательно). */
  deleteBlob: (fileId: string) => Promise<void>;
  /** Дерево, состав или статус изменились — UI перечитает. */
  onChanged: () => void;
};

export const CLOUD_DOMAIN = 'cloud.v1';
const OUTBOX_RECORD = 'cloud-outbox:';
// Блобы стёртых файлов, уже удалённые с сервера этим устройством
const GC_RECORD = 'cloud-gc';
const GC_KEEP = 2000;
const SYNC_ACTIVE_MS = 8000;
const SYNC_IDLE_MS = 60000;
const RETRY_OFFLINE_MS = 15000;
const SYNC_PAGES = 50;
const MAX_OPS_PER_BATCH = 400;
// Запрос без ответа (обрыв во время реконнекта) не должен вешать очередь модуля
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
  return code === 'ERROR_CODE_UNAVAILABLE' || code === 'ERROR_CODE_RATE_LIMITED';
}

export function createCloudSync(deps: Deps) {
  let status: CloudSyncStatus = 'loading';
  const outboxes = new Map<string, OutboxItem[]>();
  const snapshotTried = new Set<string>();
  // Чужие контейнеры, в которых доступа больше нет (сервер ответил NOT_FOUND)
  const lost = new Set<string>();
  let gcDone: string[] | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let isWanted = false;
  let isActive = false;
  let isDiscovered = false;
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

  async function run(reqs: OutReq[]) {
    for (const r of reqs) await call(r.chan, r.method, r.body);
  }

  function setStatus(next: CloudSyncStatus) {
    if (status === next) return;
    status = next;
    deps.onChanged();
  }

  function refJson(id: string) {
    return { domain: deps.serverDomain() || '', id: hexToB64(id) };
  }

  // Тело по ИМЕНИ МЕТОДА (кодек реестра)
  function encode(method: string, value: unknown) {
    const pv = deps.pv();
    if (!pv) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    return pv.encodeMethodRequest(method, JSON.stringify(value));
  }

  function engineContainers(): EngineContainer[] {
    const client = deps.client();
    if (!client) return [];
    return JSON.parse(client.cloudContainers()) as EngineContainer[];
  }

  function liveEntries() {
    return deps.stateEntries().filter((e) => !e.isRemoved);
  }

  /** Личный диск: запись журнала состояния (при двух — меньший id). */
  function rootId(): string | undefined {
    return liveEntries().filter((e) => e.role === 'root').map((e) => e.id).sort()[0];
  }

  // ── очередь отправки ───────────────────────────────────────────────────────

  async function loadOutbox(id: string) {
    const loaded = outboxes.get(id);
    if (loaded) return loaded;
    const saved = (await deps.loadRecord<OutboxItem[]>(OUTBOX_RECORD + id).catch(() => undefined)) || [];
    outboxes.set(id, saved);
    // Операции очереди уже применены локально до перезагрузки — движок их не
    // помнит (состояние без них в персисте): применить заново (идемпотентно)
    const client = deps.client();
    if (client?.cloudIsAttached(id)) {
      saved.forEach((item) => {
        try {
          client.cloudApplyLocal(id, b64ToBytes(item.op));
        } catch (e) {
          deps.log(`облако: операция из очереди не применена: ${String(e)}`);
        }
      });
    }
    return saved;
  }

  async function saveOutbox(id: string) {
    const items = outboxes.get(id) || [];
    if (items.length) await deps.saveRecord(OUTBOX_RECORD + id, items);
    else await deps.deleteRecord(OUTBOX_RECORD + id).catch(() => undefined);
  }

  // ── контейнеры ─────────────────────────────────────────────────────────────

  async function attach(id: string): Promise<boolean> {
    const client = deps.client();
    if (!client) return false;
    try {
      const [got, grants] = await Promise.all([
        call('id', 'domain.container.get', encode('domain.container.get', { container: refJson(id) })),
        call('id', 'domain.grant.list', encode('domain.grant.list', { container: refJson(id), after_version: '0' })),
      ]);
      await deps.withNeeds(() => client.cloudAttach(got, grants));
    } catch (e) {
      if (errorCode(e) === 'ERROR_CODE_NOT_FOUND') {
        dropContainer(id);
        return false;
      }
      throw e;
    }
    snapshotTried.delete(id);
    await loadOutbox(id);
    await deps.persist();
    deps.log(`облако: контейнер подключён (${id.slice(0, 8)}…)`);
    return true;
  }

  /** Доступа к контейнеру больше нет: забыть его и снять запись состояния. */
  function dropContainer(id: string) {
    const client = deps.client();
    client?.cloudForget(id);
    outboxes.delete(id);
    void deps.deleteRecord(OUTBOX_RECORD + id).catch(() => undefined);
    lost.add(id);
    const entry = liveEntries().find((e) => e.id === id);
    if (entry && entry.role === 'shared') deps.recordEntry({ ...entry, isRemoved: true });
    deps.log(`облако: доступа к контейнеру ${id.slice(0, 8)}… больше нет`);
  }

  /** Контейнеры аккаунта на сервере (свои и по грантам) → подключить новые. */
  async function discover() {
    const client = deps.client();
    const pv = deps.pv();
    if (!client || !pv) return;
    const resp = await call('id', 'domain.container.list', encode('domain.container.list', { domain: CLOUD_DOMAIN }));
    const list = JSON.parse(pv.decodeMethodResponse('domain.container.list', resp)) as {
      containers?: { ref?: { id?: string }; owner?: { address?: string } }[];
    };
    const onServer = new Map<string, string>();
    (list.containers || []).forEach((c) => {
      if (c.ref?.id) onServer.set(b64ToHex(c.ref.id), c.owner?.address || '');
    });
    const self = deps.self();
    const entries = deps.stateEntries();
    for (const [id, owner] of onServer) {
      const entry = entries.find((e) => e.id === id);
      // Отклонённое приглашение и удалённую свою папку не подключаем
      if (entry?.isRemoved || entry?.status === 'declined') continue;
      // Свой контейнер без записи состояния: другой свой клиент ещё не дописал журнал — подождём запись
      if (owner === self && !entry) continue;
      if (!client.cloudIsAttached(id)) {
        lost.delete(id);
        await attach(id);
      }
    }
    // Подключённый чужой контейнер пропал из списка — доступ отозван
    engineContainers().forEach((c) => {
      if (c.owner !== self && !onServer.has(c.id)) dropContainer(c.id);
    });
    isDiscovered = true;
  }

  async function shareWithOwnDevices(id: string) {
    const client = deps.client();
    if (!client) return;
    try {
      await run(await deps.withNeeds(() => client.cloudShareWithOwnDevices(id) as OutReq[]));
    } catch (e) {
      deps.log(`облако: ключ своим устройствам не передан: ${String(e)}`);
    }
  }

  async function createContainer(role: 'root' | 'owned', name?: string): Promise<string> {
    const client = deps.client();
    if (!client || !deps.isReady()) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const made = client.cloudCreate(Date.now()) as { id: string; request: OutReq };
    try {
      await call(made.request.chan, made.request.method, made.request.body);
    } catch (e) {
      client.cloudForget(made.id);
      throw e;
    }
    outboxes.set(made.id, []);
    deps.recordEntry({ id: made.id, domain: deps.serverDomain() || '', role });
    await deps.persist();
    deps.log(`облако: контейнер создан (${made.id.slice(0, 8)}…, ${role})`);
    await shareWithOwnDevices(made.id);
    if (name) await applyNow(made.id, [{ op: 'meta', name }]);
    return made.id;
  }

  /** Личный диск подключён (создаётся первой правкой). */
  async function ensureRoot(createIfMissing: boolean): Promise<string | undefined> {
    const client = deps.client();
    if (!client || !deps.isReady()) return undefined;
    const known = rootId();
    if (known) {
      if (client.cloudIsAttached(known) || await attach(known)) return known;
      return undefined;
    }
    if (!createIfMissing) return undefined;
    return createContainer('root');
  }

  // ── журнал и снимок ────────────────────────────────────────────────────────

  async function pullGrants(id: string) {
    const client = deps.client()!;
    const resp = await call('id', 'domain.grant.list', encode(
      'domain.grant.list', { container: refJson(id), after_version: String(client.cloudGrantVersion(id)) },
    ));
    await deps.withNeeds(() => client.cloudIngestGrants(id, resp));
  }

  async function refreshAuthors(id: string) {
    const container = engineContainers().find((c) => c.id === id);
    if (!container) return;
    const self = deps.self();
    const users = [container.owner, ...container.members.map((m) => m.user)].filter((u) => u !== self);
    for (const user of users) await deps.refreshPeerLog(user).catch(() => undefined);
  }

  async function pull(id: string): Promise<boolean> {
    const client = deps.client();
    if (!client?.cloudIsAttached(id)) return false;
    let changed = false;
    const versionBefore = client.cloudGrantVersion(id);
    await pullGrants(id);
    if (client.cloudGrantVersion(id) !== versionBefore) changed = true;
    if (!snapshotTried.has(id) && client.cloudHeadSeq(id) === 0 && client.cloudHasKey(id)) {
      snapshotTried.add(id);
      const resp = await call('id', 'domain.snapshot.get', encode('domain.snapshot.get', { container: refJson(id) }));
      try {
        if (client.cloudIngestSnapshot(id, resp) !== 0) {
          changed = true;
          // Дерево из снимка — на экран сразу, догон журнала следом
          deps.onChanged();
        }
      } catch (e) {
        deps.log(`облако: снимок не прочитан: ${String(e)}`);
      }
    }
    let isStrict = true;
    for (let page = 0; page < SYNC_PAGES; page++) {
      const resp = await call('id', 'domain.op.sync', encode(
        'domain.op.sync', { container: refJson(id), after_seq: String(client.cloudHeadSeq(id)), max_bytes: 0 },
      ));
      const r = client.cloudIngestSync(id, resp, isStrict) as {
        applied: number; more: boolean; grantsBehind: boolean; authorsBehind: boolean;
      };
      if (r.applied) changed = true;
      if (r.authorsBehind) {
        // Ключ автора неизвестен: новое устройство участника — обновить журналы
        // устройств и повторить; что не опознано и после этого — пропускается
        await refreshAuthors(id);
        isStrict = false;
        continue;
      }
      isStrict = true;
      if (r.grantsBehind) {
        await pullGrants(id);
        continue;
      }
      if (!r.more) break;
    }
    return changed;
  }

  async function maybeSnapshot(id: string) {
    const client = deps.client();
    if (!client?.cloudHasKey(id)) return;
    try {
      const req = client.cloudSnapshotRequest(id, Date.now()) as OutReq | undefined;
      if (!req) return;
      await call(req.chan, req.method, req.body);
      deps.log(`облако: снимок записан (${id.slice(0, 8)}…, seq ${client.cloudHeadSeq(id)})`);
    } catch (e) {
      deps.log(`облако: снимок не записан: ${String(e)}`);
    }
  }

  async function sendOutbox(id: string) {
    const client = deps.client();
    if (!client?.cloudIsAttached(id)) return;
    const outbox = await loadOutbox(id);
    while (outbox.length) {
      const item = outbox[0];
      if (!client.cloudHasKey(id)) return;
      try {
        const req = client.cloudSeal(id, b64ToBytes(item.op), item.opId, Date.now()) as OutReq;
        await call(req.chan, req.method, req.body);
      } catch (e) {
        const code = errorCode(e);
        if (code === 'ERROR_CODE_EXPIRED') {
          // Эпоха сменилась: догнать гранты, ключ придёт по E2E
          const before = client.cloudGrantVersion(id);
          await pullGrants(id);
          if (client.cloudGrantVersion(id) === before || !client.cloudHasKey(id)) return;
          continue;
        }
        if (code === 'ERROR_CODE_FORBIDDEN' || code === 'ERROR_CODE_NOT_FOUND' || code === 'ERROR_CODE_INVALID') {
          // Права записи больше нет (роль понижена, доступ отозван): правка не будет принята
          deps.log(`облако: правка отвергнута сервером (${code})`);
        } else if (code !== 'ERROR_CODE_DUPLICATE') {
          throw e;
        }
      }
      outbox.shift();
      await saveOutbox(id);
    }
  }

  /** Блобы окончательно удалённых файлов, загруженные этим аккаунтом, — стереть на сервере. */
  async function collectGarbage(id: string) {
    const client = deps.client();
    const self = deps.self();
    const json = client?.cloudStateJson(id);
    if (!json || !self) return;
    const purged = (JSON.parse(json) as { purgedBlobs?: { fileId: string; uploader: string }[] }).purgedBlobs || [];
    if (!purged.length) return;
    gcDone = gcDone || (await deps.loadRecord<string[]>(GC_RECORD).catch(() => undefined)) || [];
    const done = new Set(gcDone);
    let hasChanges = false;
    for (const blob of purged) {
      if (blob.uploader !== self || done.has(blob.fileId)) continue;
      try {
        await deps.deleteBlob(blob.fileId);
      } catch (e) {
        if (errorCode(e) !== 'ERROR_CODE_NOT_FOUND') continue;
      }
      gcDone.push(blob.fileId);
      done.add(blob.fileId);
      hasChanges = true;
    }
    if (!hasChanges) return;
    gcDone = gcDone.slice(-GC_KEEP);
    await deps.saveRecord(GC_RECORD, gcDone);
  }

  async function syncContainer(id: string): Promise<boolean> {
    try {
      await sendOutbox(id);
      const changed = await pull(id);
      await maybeSnapshot(id);
      await collectGarbage(id);
      return changed;
    } catch (e) {
      if (errorCode(e) === 'ERROR_CODE_NOT_FOUND') {
        dropContainer(id);
        return true;
      }
      throw e;
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void syncNow();
    }, RETRY_OFFLINE_MS);
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    if (!isWanted) return;
    syncTimer = setTimeout(() => {
      void syncNow();
    }, isActive ? SYNC_ACTIVE_MS : SYNC_IDLE_MS);
  }

  function syncNow(shouldDiscover = false) {
    return serial(async () => {
      const client = deps.client();
      try {
        if (!client || !deps.isReady()) {
          setStatus(deps.needsLinking() ? 'needs-linking' : 'loading');
          return;
        }
        if (shouldDiscover || !isDiscovered || isActive) await discover();
        await ensureRoot(false);
        let changed = false;
        // В фоне — только личный диск (нужен «Сохранить в облако»)
        const ids = engineContainers().map((c) => c.id).filter((id) => isActive || id === rootId());
        for (const id of ids) {
          if (await syncContainer(id)) changed = true;
        }
        await deps.persist();
        const hasMissingKey = engineContainers().some((c) => c.id === rootId() && !c.hasKey);
        setStatus(hasMissingKey ? 'no-key' : 'ready');
        lastError = undefined;
        if (changed) deps.onChanged();
      } catch (e) {
        lastError = String(e);
        deps.log(`облако: синхронизация: ${String(e)}`);
        if (isUnavailable(e)) {
          setStatus('offline');
          scheduleRetry();
        }
      } finally {
        scheduleSync();
      }
    });
  }

  // ── правки ─────────────────────────────────────────────────────────────────

  async function applyNow(id: string, ops: unknown[]) {
    const client = deps.client();
    if (!client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const outbox = await loadOutbox(id);
    for (let i = 0; i < ops.length; i += MAX_OPS_PER_BATCH) {
      const local = client.cloudPrepareLocal(id, JSON.stringify({ ops: ops.slice(i, i + MAX_OPS_PER_BATCH) })) as {
        opId: string; op: Uint8Array;
      };
      outbox.push({ opId: local.opId, op: bytesToB64(local.op) });
    }
    await saveOutbox(id);
    await deps.persist();
    deps.onChanged();
  }

  // ── API ────────────────────────────────────────────────────────────────────

  /** Раздел открыт (`active`) либо облако понадобилось в фоне. */
  async function ensure(active: boolean) {
    isWanted = true;
    if (active !== isActive) {
      isActive = active;
      scheduleSync();
    }
    await syncNow(true);
  }

  function setActive(active: boolean) {
    if (isActive === active) return;
    isActive = active;
    if (active) void syncNow(true);
    else scheduleSync();
  }

  /** Правки дерева контейнера (`container` — id либо `root`): применяются
   * локально сразу (ошибка движка — исключением), на сервер уходят очередью. */
  function apply(container: string, ops: unknown[]): Promise<string> {
    return serial(async () => {
      const id = container === 'root' ? await ensureRoot(true) : container;
      if (!id) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      await applyNow(id, ops);
      return id;
    }).then((id) => {
      void serial(() => sendOutbox(id).catch((e) => {
        lastError = String(e);
        if (isUnavailable(e)) {
          setStatus('offline');
          scheduleRetry();
        }
      })).then(() => deps.onChanged());
      return id;
    });
  }

  function containers(): CloudContainerInfo[] {
    const self = deps.self();
    const entries = deps.stateEntries();
    const root = rootId();
    return engineContainers().filter((c) => !lost.has(c.id)).map((c) => {
      const entry = entries.find((e) => e.id === c.id);
      let kind: CloudContainerKind = 'owned';
      if (c.id === root) kind = 'root';
      else if (c.owner !== self) kind = entry?.status === 'accepted' ? 'shared' : 'invite';
      return {
        id: c.id, kind, role: c.role, owner: c.owner, name: c.name, hasKey: c.hasKey, members: c.members,
      };
    }).filter((c) => c.role);
  }

  function stateJson(id: string): string | undefined {
    return deps.client()?.cloudStateJson(id);
  }

  function currentStatus(): CloudSyncStatus {
    const client = deps.client();
    if (!client || !deps.isReady()) return deps.needsLinking() ? 'needs-linking' : 'loading';
    return status === 'loading' || status === 'needs-linking' ? 'ready' : status;
  }

  /** Новая совместная папка (свой контейнер с названием). */
  function createFolder(name: string) {
    return serial(() => createContainer('owned', name));
  }

  /** Выдать доступ либо сменить роль участника. */
  function share(id: string, user: string, role: 'editor' | 'reader', inviteText: string) {
    return serial(async () => {
      const client = deps.client();
      if (!client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      const reqs = await deps.withNeeds(
        () => client.cloudGrant(id, user, role === 'editor', inviteText, Date.now()) as OutReq[],
      );
      await runGrantRequests(id, reqs);
    });
  }

  function unshare(id: string, user: string) {
    return serial(async () => {
      const client = deps.client();
      if (!client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      const reqs = await deps.withNeeds(() => client.cloudRevoke(id, user, Date.now()) as OutReq[]);
      await runGrantRequests(id, reqs);
    });
  }

  /** Запись журнала грантов уже применена локально: при отказе сервера —
   * перечитать журнал с сервера, раздачу ключей не слать. */
  async function runGrantRequests(id: string, reqs: OutReq[]) {
    try {
      await run(reqs);
    } catch (e) {
      deps.client()?.cloudForget(id);
      await attach(id).catch(() => undefined);
      throw e;
    } finally {
      await deps.persist();
      deps.onChanged();
    }
  }

  /** Ответ на приглашение: принять — запись состояния; отклонить — выйти. */
  function answerInvite(id: string, accept: boolean) {
    return serial(async () => {
      const container = engineContainers().find((c) => c.id === id);
      const entry: CloudStateEntry = {
        id,
        domain: deps.serverDomain() || '',
        role: 'shared',
        owner: container?.owner,
        status: accept ? 'accepted' : 'declined',
      };
      if (!accept) await leaveNow(id);
      deps.recordEntry(entry);
      deps.onChanged();
    });
  }

  async function leaveNow(id: string) {
    const client = deps.client();
    if (!client?.cloudIsAttached(id)) return;
    const req = client.cloudLeave(id, Date.now()) as OutReq;
    outboxes.delete(id);
    lost.add(id);
    await deps.deleteRecord(OUTBOX_RECORD + id).catch(() => undefined);
    await call(req.chan, req.method, req.body).catch((e) => {
      if (errorCode(e) !== 'ERROR_CODE_NOT_FOUND') throw e;
    });
    await deps.persist();
  }

  /** Покинуть чужую папку. */
  function leave(id: string) {
    return serial(async () => {
      const entry = liveEntries().find((e) => e.id === id);
      await leaveNow(id);
      deps.recordEntry({
        id,
        domain: deps.serverDomain() || '',
        role: 'shared',
        owner: entry?.owner,
        status: entry?.status,
        isRemoved: true,
      });
      deps.onChanged();
    });
  }

  /** Удалить свою совместную папку: убрать участников и снять запись
   * (содержимое вызывающий стирает операциями `purge` до этого). */
  function removeFolder(id: string) {
    return serial(async () => {
      const client = deps.client();
      if (!client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      const container = engineContainers().find((c) => c.id === id);
      for (const member of container?.members || []) {
        await run(await deps.withNeeds(() => client.cloudRevoke(id, member.user, Date.now()) as OutReq[]));
      }
      await sendOutbox(id).catch(() => undefined);
      await collectGarbage(id).catch(() => undefined);
      client.cloudForget(id);
      outboxes.delete(id);
      lost.add(id);
      deps.recordEntry({ id, domain: deps.serverDomain() || '', role: 'owned', isRemoved: true });
      await deps.persist();
      deps.onChanged();
    });
  }

  /** Владелец увидел выход участника либо отзыв его устройства: сменить эпоху. */
  function rotate(id: string) {
    return serial(async () => {
      const client = deps.client();
      if (!client) return;
      await run(await deps.withNeeds(() => client.cloudRotate(id, Date.now()) as OutReq[]));
      await deps.persist();
    });
  }

  function keysExport(): string | undefined {
    return deps.client()?.cloudKeysExport();
  }

  function keysImport(json: string) {
    try {
      deps.client()?.cloudKeysImport(json);
    } catch (e) {
      deps.log(`облако: ключи из экспорта не приняты: ${String(e)}`);
    }
  }

  /** Событие движка `cloudChanged` (ключ принят / контейнер надо подключить). */
  function onEngineEvent(id: string) {
    lost.delete(id);
    // Приглашение приходит и при закрытом разделе: подключить контейнер сразу
    isWanted = true;
    void serial(async () => {
      const client = deps.client();
      if (!client || !deps.isReady()) return;
      try {
        if (!client.cloudIsAttached(id)) await attach(id);
        if (client.cloudIsAttached(id)) await syncContainer(id);
        await deps.persist();
      } catch (e) {
        deps.log(`облако: контейнер ${id.slice(0, 8)}… не подключён: ${String(e)}`);
      }
      deps.onChanged();
    });
  }

  function reset() {
    if (syncTimer) clearTimeout(syncTimer);
    if (retryTimer) clearTimeout(retryTimer);
    syncTimer = undefined;
    retryTimer = undefined;
    status = 'loading';
    outboxes.clear();
    snapshotTried.clear();
    lost.clear();
    gcDone = undefined;
    isWanted = false;
    isActive = false;
    isDiscovered = false;
    lastError = undefined;
  }

  return {
    ensure,
    setActive,
    apply,
    syncNow,
    containers,
    stateJson,
    rootId,
    status: currentStatus,
    lastError: () => lastError,
    hasPending: (id: string) => Boolean(outboxes.get(id)?.length),
    createFolder,
    share,
    unshare,
    answerInvite,
    leave,
    removeFolder,
    rotate,
    keysExport,
    keysImport,
    onEngineEvent,
    reset,
  };
}

export type CloudSync = ReturnType<typeof createCloudSync>;
