import type { CloudNode } from '../../../components/parvane/cloud/cloudModel';
import type { Protocol, PvClient } from './engine';

import { expiredTrashOf } from '../../../components/parvane/cloud/cloudModel';
import { isTimerSyncMode, pollDelay } from './l2';
import { V2Error } from './transport';

// Parvane (spec 016): раздел «Облако» — контейнеры домена `cloud.v1` (шард
// domains): личный диск и совместные папки, свои и чужие. Движок держит дерево,
// ключи эпох, журнал грантов и метки; здесь — жизненный цикл: найти контейнеры
// (журнал личного состояния + `domain.container.list`), подключить, снимок и
// журнал (`domain.op.sync`), очередь отправки своих операций (переживает
// перезагрузку), снимок по порогу, опрос (8 с при открытом разделе и видимой
// вкладке, иначе 60 с; при возврате — сразу), доступ участников, сборка блобов
// стёртых файлов (после применённых операций), срок корзины (раз в час).
// Персист и событие для UI — только когда дерево менялось; `revision()` растёт
// при каждом изменении деревьев в движке — по ней `cloudDrive` держит кэш
// разобранных деревьев. Статусы для UI — как у планировщика: `loading`,
// `needs-linking` (диск не создаём), `no-key`, `offline`, `ready`.

export type CloudSyncStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';
export type CloudContainerKind = 'root' | 'owned' | 'shared' | 'invite';
// Сверка личного диска с сервером: `none` — у аккаунта на сервере нет ни одного своего контейнера облака
// (диск ещё никто не создавал), `synced` — журнал диска только что дочитан, `unknown` — судить нельзя
export type CloudDriveCheck = 'unknown' | 'none' | 'synced';
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
type OutReq = { chan: Chan; method: string; body: Uint8Array; dest?: string };
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
  // dest — сервер объекта (spec 028)
  call: (chan: Chan, method: string, body: Uint8Array, dest?: string) => Promise<Uint8Array>;
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
// Блобы, загруженные или скопированные самим этим устройством: uploader в узле папки задаёт автор операции,
// стирать на сервере можно только то, что мы сами положили (иначе участник папки укажет чужой file_id)
const OWN_BLOBS_RECORD = 'cloud-own-blobs';
// Серверы, приглашавшие в совместные папки (spec 028): папка живёт у владельца, и её видно только в
// списке его сервера — до подключения домен известен лишь из приглашения
const REMOTE_DOMAINS_RECORD = 'cloud-remote-domains';
const GC_KEEP = 2000;
const OWN_BLOBS_KEEP = 20000;
const SYNC_ACTIVE_MS = 8000;
const SYNC_IDLE_MS = 60000;
const RETRY_OFFLINE_MS = 15000;
const SYNC_PAGES = 50;
const MAX_OPS_PER_BATCH = 400;
// Запрос без ответа (обрыв во время реконнекта) не должен вешать очередь модуля
const CALL_TIMEOUT_MS = 20000;
// Срок корзины проверяется раз в час (и при первом синке контейнера), а не каждый опрос
const TRASH_CHECK_MS = 60 * 60 * 1000;

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
  let ownBlobs: string[] | undefined;
  // Контейнеры, у которых сборка блобов и срок корзины уже проверялись (и когда)
  const gcChecked = new Set<string>();
  const trashCheckedAt = new Map<string, number>();
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let isWanted = false;
  let isActive = false;
  let isDiscovered = false;
  let areListenersSet = false;
  // Движок менял деревья, а персиста после этого не было
  let isDirty = false;
  // Растёт при каждом изменении деревьев/состава в движке — ключ кэша разобранных деревьев
  let revision = 0;
  // Кэш личного диска: записи журнала состояния приходят тем же массивом, пока снимок не менялся
  let rootCache: { entries: CloudStateEntry[]; id: string | undefined } | undefined;
  // Сколько своих контейнеров облака назвал сервер при последнем опросе списка
  let ownOnServer: number | undefined;
  // Свои контейнеры на сервере без записи журнала состояния (по последнему обходу): новый диск при них не заводим
  let ownWithoutEntry = 0;
  let lastError: string | undefined;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  /** Движок изменил дерево либо состав: кэш деревьев устарел, персист нужен. */
  function touch() {
    revision += 1;
    isDirty = true;
  }

  async function persistIfDirty() {
    if (!isDirty) return;
    isDirty = false;
    await deps.persist();
  }

  function call(chan: Chan, method: string, body: Uint8Array, dest?: string): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new V2Error('ERROR_CODE_UNAVAILABLE')), CALL_TIMEOUT_MS);
      deps.call(chan, method, body, dest).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  async function run(reqs: OutReq[]) {
    for (const r of reqs) await call(r.chan, r.method, r.body, r.dest);
  }

  function setStatus(next: CloudSyncStatus) {
    if (status === next) return;
    status = next;
    deps.onChanged();
  }

  /** Домен сервера контейнера (spec 028): чужая совместная папка живёт у владельца. */
  function domainOf(id: string) {
    return deps.client()?.cloudDomain(id) || deps.serverDomain() || '';
  }

  function refJson(id: string) {
    return { domain: domainOf(id), id: hexToB64(id) };
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
    const entries = deps.stateEntries();
    if (rootCache && rootCache.entries === entries) return rootCache.id;
    const id = entries.filter((e) => !e.isRemoved && e.role === 'root').map((e) => e.id).sort()[0];
    rootCache = { entries, id };
    return id;
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
    if (client?.cloudIsAttached(id) && saved.length) {
      saved.forEach((item) => {
        try {
          client.cloudApplyLocal(id, b64ToBytes(item.op));
        } catch (e) {
          deps.log(`облако: операция из очереди не применена: ${String(e)}`);
        }
      });
      touch();
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
        call('id', 'domain.container.get', encode('domain.container.get', { container: refJson(id) }), domainOf(id)),
        call('id', 'domain.grant.list', encode(
          'domain.grant.list', { container: refJson(id), after_version: '0' },
        ), domainOf(id)),
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
    touch();
    await loadOutbox(id);
    isDirty = false;
    await deps.persist();
    deps.log(`облако: контейнер подключён (${id.slice(0, 8)}…)`);
    return true;
  }

  /** Доступа к контейнеру больше нет: забыть его и снять запись состояния. */
  function dropContainer(id: string) {
    const client = deps.client();
    client?.cloudForget(id);
    touch();
    outboxes.delete(id);
    void deps.deleteRecord(OUTBOX_RECORD + id).catch(() => undefined);
    lost.add(id);
    const entry = liveEntries().find((e) => e.id === id);
    if (entry && entry.role === 'shared') deps.recordEntry({ ...entry, isRemoved: true });
    deps.log(`облако: доступа к контейнеру ${id.slice(0, 8)}… больше нет`);
    // Папка исчезла — UI перечитает список
    deps.onChanged();
  }

  let remoteDomains: Set<string> | undefined;

  async function loadRemoteDomains() {
    remoteDomains = remoteDomains
      || new Set((await deps.loadRecord<string[]>(REMOTE_DOMAINS_RECORD).catch(() => undefined)) || []);
    return remoteDomains;
  }

  /** Приглашение в папку другого сервера: спрашивать список и у него (домен — сервер пригласившего). */
  async function noteRemoteDomain(domain: string) {
    const d = domain.toLowerCase();
    if (!d || d === (deps.serverDomain() || '').toLowerCase()) return;
    const set = await loadRemoteDomains();
    if (set.has(d)) return;
    set.add(d);
    await deps.saveRecord(REMOTE_DOMAINS_RECORD, [...set]).catch(() => undefined);
  }

  /** Контейнеры аккаунта на сервере (свои и по грантам) → подключить новые. */
  async function discover() {
    const client = deps.client();
    const pv = deps.pv();
    if (!client || !pv) return;
    // Свой сервер и серверы чужих папок (spec 028): папка видна только в списке сервера владельца
    const own = (deps.serverDomain() || '').toLowerCase();
    const domains = new Set<string>([own, ...await loadRemoteDomains()]);
    engineContainers().forEach((c) => domains.add(domainOf(c.id).toLowerCase()));
    liveEntries().filter((e) => e.domain).forEach((e) => domains.add(e.domain.toLowerCase()));
    const onServer = new Map<string, string>();
    const listed = new Set<string>();
    const withContainers = new Set<string>();
    for (const domain of domains) {
      let resp: Uint8Array;
      try {
        const body = encode('domain.container.list', { domain: CLOUD_DOMAIN });
        resp = await call('id', 'domain.container.list', body, domain);
      } catch (e) {
        // Свой сервер обязан ответить; недоступный чужой — папки его не считаем отозванными
        if (domain === own) throw e;
        deps.log(`облако: список папок сервера ${domain} не получен (${errorCode(e)})`);
        continue;
      }
      listed.add(domain);
      const list = JSON.parse(pv.decodeMethodResponse('domain.container.list', resp)) as {
        containers?: { ref?: { id?: string }; owner?: { address?: string } }[];
      };
      (list.containers || []).forEach((c) => {
        if (c.ref?.id) {
          onServer.set(b64ToHex(c.ref.id), c.owner?.address || '');
          withContainers.add(domain);
        }
      });
    }
    // Чужой сервер, из которого пришло приглашение, но контейнеров для нас там нет (письмо без папки): не опрашивать вечно
    const remotes = await loadRemoteDomains();
    let isPruned = false;
    for (const domain of [...remotes]) {
      const isKnown = engineContainers().some((c) => domainOf(c.id).toLowerCase() === domain)
        || liveEntries().some((e) => e.domain?.toLowerCase() === domain);
      if (listed.has(domain) && !withContainers.has(domain) && !isKnown) {
        remotes.delete(domain);
        isPruned = true;
      }
    }
    if (isPruned) await deps.saveRecord(REMOTE_DOMAINS_RECORD, [...remotes]).catch(() => undefined);
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
        // Один не подключившийся контейнер не останавливает остальные (раньше исключение обрывало весь обход, и
        // синхронизация облака стояла: «долгая загрузка» и пустые «Файлы»)
        try {
          await attach(id);
        } catch (e) {
          deps.log(`облако: контейнер ${id.slice(0, 8)}… не подключён: ${String(e)}`);
        }
      }
    }
    // Папка, удалённая на другом своём устройстве: контейнер на сервере остаётся, а запись журнала снята — забыть и здесь
    engineContainers().forEach((c) => {
      if (lost.has(c.id) || !entries.find((e) => e.id === c.id)?.isRemoved) return;
      client.cloudForget(c.id);
      touch();
      outboxes.delete(c.id);
      lost.add(c.id);
      deps.log(`облако: контейнер ${c.id.slice(0, 8)}… удалён на другом устройстве`);
      deps.onChanged();
    });
    // Подключённый чужой контейнер пропал из списка — доступ отозван
    engineContainers().forEach((c) => {
      if (c.owner !== self && !onServer.has(c.id) && listed.has(domainOf(c.id).toLowerCase())) dropContainer(c.id);
    });
    ownOnServer = [...onServer.values()].filter((owner) => owner === self).length;
    ownWithoutEntry = [...onServer].filter(([id, owner]) => owner === self && !entries.some((e) => e.id === id)).length;
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
    touch();
    outboxes.set(made.id, []);
    deps.recordEntry({ id: made.id, domain: deps.serverDomain() || '', role });
    isDirty = false;
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
    // Новый диск — только когда его точно нет: свой контейнер без записи журнала состояния может оказаться диском,
    // запись которого ещё не дочитана. Второй диск с меньшим id подменил бы настоящий на всех устройствах
    await discover();
    if (rootId()) return ensureRoot(false);
    if (ownWithoutEntry > 0) {
      deps.log('облако: личный диск не создан — на сервере есть свой контейнер без записи журнала состояния');
      throw new V2Error('ERROR_CODE_UNAVAILABLE');
    }
    return createContainer('root');
  }

  // ── журнал и снимок ────────────────────────────────────────────────────────

  async function pullGrants(id: string) {
    const client = deps.client()!;
    const resp = await call('id', 'domain.grant.list', encode(
      'domain.grant.list', { container: refJson(id), after_version: String(client.cloudGrantVersion(id)) },
    ), domainOf(id));
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
    const before = engineContainers().find((c) => c.id === id);
    await pullGrants(id);
    if (client.cloudGrantVersion(id) !== versionBefore) {
      changed = true;
      touch();
      // Участник ушёл сам (состав уменьшился, эпоха прежняя): владелец меняет
      // эпоху, чтобы ушедший не читал новое
      const after = engineContainers().find((c) => c.id === id);
      const hasLeft = before && after && after.role === 'owner'
        && after.members.length < before.members.length && after.epoch === before.epoch;
      if (hasLeft && client.cloudHasKey(id)) {
        try {
          await run(await deps.withNeeds(() => client.cloudRotate(id, Date.now()) as OutReq[]));
          deps.log(`облако: участник покинул папку ${id.slice(0, 8)}… — эпоха ключа сменена`);
        } catch (e) {
          deps.log(`облако: смена эпохи после выхода участника не удалась: ${String(e)}`);
        }
      }
    }
    if (!snapshotTried.has(id) && client.cloudHeadSeq(id) === 0 && client.cloudHasKey(id)) {
      snapshotTried.add(id);
      const body = encode('domain.snapshot.get', { container: refJson(id) });
      const resp = await call('id', 'domain.snapshot.get', body, domainOf(id));
      try {
        if (client.cloudIngestSnapshot(id, resp) !== 0) {
          changed = true;
          touch();
          deps.log(`облако: ${id.slice(0, 8)}… снимок принят (seq ${client.cloudHeadSeq(id)})`);
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
      ), domainOf(id));
      const r = client.cloudIngestSync(id, resp, isStrict) as {
        applied: number; more: boolean; grantsBehind: boolean; authorsBehind: boolean;
      };
      if (r.applied) {
        changed = true;
        touch();
        deps.log(`облако: ${id.slice(0, 8)}… догнано ${r.applied} операций (seq ${client.cloudHeadSeq(id)})`);
      }
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
      await call(req.chan, req.method, req.body, req.dest);
      // Движок запомнил seq снимка — в персист (дерево не менялось, ревизия прежняя)
      isDirty = true;
      deps.log(`облако: снимок записан (${id.slice(0, 8)}…, seq ${client.cloudHeadSeq(id)})`);
    } catch (e) {
      deps.log(`облако: снимок не записан: ${String(e)}`);
    }
  }

  /** Отправить очередь правок; возвращает число правок, отвергнутых сервером. */
  async function sendOutbox(id: string): Promise<number> {
    const client = deps.client();
    if (!client?.cloudIsAttached(id)) return 0;
    const outbox = await loadOutbox(id);
    let rejected = 0;
    while (outbox.length) {
      const item = outbox[0];
      if (!client.cloudHasKey(id)) return rejected;
      try {
        const req = client.cloudSeal(id, b64ToBytes(item.op), item.opId, Date.now()) as OutReq;
        await call(req.chan, req.method, req.body, req.dest);
      } catch (e) {
        const code = errorCode(e);
        if (code === 'ERROR_CODE_EXPIRED') {
          // Эпоха сменилась: догнать гранты, ключ придёт по E2E
          const before = client.cloudGrantVersion(id);
          await pullGrants(id);
          if (client.cloudGrantVersion(id) === before || !client.cloudHasKey(id)) return rejected;
          continue;
        }
        if (code === 'ERROR_CODE_FORBIDDEN' || code === 'ERROR_CODE_NOT_FOUND' || code === 'ERROR_CODE_INVALID') {
          // Права записи больше нет (роль понижена, доступ отозван): правка не будет принята
          deps.log(`облако: правка отвергнута сервером (${code})`);
          rejected += 1;
        } else if (code !== 'ERROR_CODE_DUPLICATE') {
          throw e;
        }
      }
      outbox.shift();
      await saveOutbox(id);
    }
    return rejected;
  }

  /** Запомнить блоб, который это устройство само загрузило/скопировало в облако (сборка мусора трогает только такие). */
  async function noteOwnBlob(fileId: string) {
    if (!fileId) return;
    ownBlobs = ownBlobs || (await deps.loadRecord<string[]>(OWN_BLOBS_RECORD).catch(() => undefined)) || [];
    if (ownBlobs.includes(fileId)) return;
    ownBlobs.push(fileId);
    ownBlobs = ownBlobs.slice(-OWN_BLOBS_KEEP);
    await deps.saveRecord(OWN_BLOBS_RECORD, ownBlobs).catch(() => undefined);
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
    ownBlobs = ownBlobs || (await deps.loadRecord<string[]>(OWN_BLOBS_RECORD).catch(() => undefined)) || [];
    const own = new Set(ownBlobs);
    let hasChanges = false;
    for (const blob of purged) {
      if (blob.uploader !== self || done.has(blob.fileId) || !own.has(blob.fileId)) continue;
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
    // Место освободилось — UI перечитает показатель
    deps.onChanged();
  }

  /** Срок корзины: сервер не знает, что в ней лежит, — пролежавшее дольше срока
   * стирает устройство владельца (в совместной папке — только владелец). */
  async function purgeExpiredTrash(id: string): Promise<boolean> {
    const client = deps.client();
    const container = engineContainers().find((c) => c.id === id);
    const isOwner = container?.role === 'owner' || id === rootId();
    if (!client || !container || !isOwner || !client.cloudHasKey(id)) return false;
    const json = client.cloudStateJson(id);
    if (!json) return false;
    const now = Date.now();
    const expired = expiredTrashOf((JSON.parse(json) as { nodes?: CloudNode[] }).nodes || [], now);
    if (!expired.length) return false;
    deps.log(`облако: срок корзины вышел у ${expired.length} объектов — стираются`);
    try {
      await applyNow(id, expired.map((n) => ({ op: 'purge', id: n.id, at: now })));
    } catch (e) {
      // Движок правку не принял — синхронизация из-за этого останавливаться не должна
      deps.log(`облако: корзина не очищена: ${String(e)}`);
      return false;
    }
    await sendOutbox(id);
    return true;
  }

  async function syncContainer(id: string): Promise<boolean> {
    try {
      await sendOutbox(id);
      const changed = await pull(id);
      // Срок корзины — раз в час и после журнала: восстановленное на другом
      // устройстве уже не в корзине
      const now = Date.now();
      const isTrashDue = now - (trashCheckedAt.get(id) || 0) >= TRASH_CHECK_MS;
      if (isTrashDue) trashCheckedAt.set(id, now);
      const purged = isTrashDue ? await purgeExpiredTrash(id) : false;
      await maybeSnapshot(id);
      // Сборка блобов стёртых файлов — только когда дерево менялось (и один раз
      // после запуска: стёртое до перезагрузки могло остаться не собранным)
      if (changed || purged || !gcChecked.has(id)) {
        gcChecked.add(id);
        await collectGarbage(id);
      }
      return changed || purged;
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

  function isHidden() {
    return typeof document !== 'undefined' && document.hidden;
  }

  /** Следующий опрос: частый при открытом разделе и видимой вкладке, иначе редкий. */
  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = undefined;
    if (!isWanted) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void syncNow();
    }, pollDelay(SYNC_ACTIVE_MS, SYNC_IDLE_MS, isActive && !isHidden()));
  }

  function setListeners() {
    if (areListenersSet || typeof document === 'undefined') return;
    areListenersSet = true;
    document.addEventListener('visibilitychange', () => {
      if (!isWanted) return;
      // Вкладка снова видна при открытом разделе: догнать сразу
      if (!document.hidden && isActive && !isTimerSyncMode()) void syncNow();
      else scheduleSync();
    });
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
        await persistIfDirty();
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
    touch();
    await saveOutbox(id);
    isDirty = false;
    await deps.persist();
    deps.onChanged();
  }

  // ── API ────────────────────────────────────────────────────────────────────

  /** Раздел открыт (`active`) либо облако понадобилось в фоне. */
  async function ensure(active: boolean) {
    isWanted = true;
    setListeners();
    if (active !== isActive) {
      isActive = active;
      scheduleSync();
    }
    await syncNow(true);
  }

  function setActive(active: boolean) {
    // Открытый раздел — потребитель облака: после сброса сессии (привязка устройства) опрос иначе не возобновлялся
    if (active) {
      isWanted = true;
      setListeners();
    }
    if (isActive === active) return;
    isActive = active;
    if (active && !isHidden() && !isTimerSyncMode()) void syncNow(true);
    else scheduleSync();
  }

  /** Правки дерева контейнера (`container` — id либо `root`): применяются
   * локально сразу (ошибка движка — исключением), на сервер уходят очередью.
   * Экран узнаёт о правке один раз — из `applyNow`; отправка очереди дерево
   * не меняет (смена статуса сообщается сама). */
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
      }));
      return id;
    });
  }

  /** Дослать очередь контейнера и стереть блобы удалённого; `true` — сервер принял всё. */
  function flush(id: string): Promise<boolean> {
    return serial(async () => {
      const rejected = await sendOutbox(id);
      await collectGarbage(id).catch(() => undefined);
      return !rejected && !outboxes.get(id)?.length;
    });
  }

  /** Можно ли считать локальное дерево личного диска полным: перед правкой «только если ещё нет»
   * (первая заметка хранилища). Список контейнеров и журнал диска перечитываются с сервера прямо здесь. */
  function checkDrive(): Promise<CloudDriveCheck> {
    return serial(async (): Promise<CloudDriveCheck> => {
      const client = deps.client();
      if (!client || !deps.isReady() || deps.needsLinking() || status !== 'ready') return 'unknown';
      try {
        const root = rootId();
        if (!root) {
          // Диск другого своего устройства виден в списке сервера раньше, чем доходит запись журнала состояния
          await discover();
          return !rootId() && ownOnServer === 0 ? 'none' : 'unknown';
        }
        if (!client.cloudIsAttached(root) || !client.cloudHasKey(root)) return 'unknown';
        if (await pull(root)) deps.onChanged();
        return 'synced';
      } catch (e) {
        deps.log(`облако: сверка личного диска: ${String(e)}`);
        return 'unknown';
      }
    });
  }

  function containers(): CloudContainerInfo[] {
    const self = deps.self();
    const entries = deps.stateEntries();
    const root = rootId();
    // Удалённая запись журнала — папки больше нет (до обхода `discover` контейнер ещё в движке)
    const isGone = (id: string) => lost.has(id) || Boolean(entries.find((e) => e.id === id)?.isRemoved);
    return engineContainers().filter((c) => !isGone(c.id)).map((c) => {
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
    touch();
    try {
      await run(reqs);
    } catch (e) {
      deps.client()?.cloudForget(id);
      await attach(id).catch(() => undefined);
      throw e;
    } finally {
      isDirty = false;
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
    touch();
    outboxes.delete(id);
    lost.add(id);
    await deps.deleteRecord(OUTBOX_RECORD + id).catch(() => undefined);
    await call(req.chan, req.method, req.body, req.dest).catch((e) => {
      if (errorCode(e) !== 'ERROR_CODE_NOT_FOUND') throw e;
    });
    isDirty = false;
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
      touch();
      outboxes.delete(id);
      lost.add(id);
      deps.recordEntry({ id, domain: deps.serverDomain() || '', role: 'owned', isRemoved: true });
      isDirty = false;
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
      touch();
      isDirty = false;
      await deps.persist();
    });
  }

  function keysExport(): string | undefined {
    return deps.client()?.cloudKeysExport();
  }

  function keysImport(json: string) {
    try {
      deps.client()?.cloudKeysImport(json);
      touch();
    } catch (e) {
      deps.log(`облако: ключи из экспорта не приняты: ${String(e)}`);
    }
  }

  /** Событие движка `cloudChanged` (ключ принят / контейнер надо подключить). */
  function onEngineEvent(id: string) {
    lost.delete(id);
    // Приглашение приходит и при закрытом разделе: подключить контейнер сразу
    isWanted = true;
    setListeners();
    void serial(async () => {
      const client = deps.client();
      if (!client || !deps.isReady()) return;
      // Ключ принят движком — дерево могло стать читаемым, экран перечитает
      let changed = true;
      try {
        if (!client.cloudIsAttached(id)) await attach(id);
        if (client.cloudIsAttached(id)) changed = (await syncContainer(id)) || changed;
        await persistIfDirty();
      } catch (e) {
        deps.log(`облако: контейнер ${id.slice(0, 8)}… не подключён: ${String(e)}`);
      }
      touch();
      isDirty = false;
      if (changed) deps.onChanged();
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
    ownBlobs = undefined;
    gcChecked.clear();
    trashCheckedAt.clear();
    isWanted = false;
    isActive = false;
    isDiscovered = false;
    isDirty = false;
    rootCache = undefined;
    revision += 1;
    ownOnServer = undefined;
    ownWithoutEntry = 0;
    lastError = undefined;
  }

  return {
    ensure,
    setActive,
    apply,
    flush,
    syncNow,
    containers,
    stateJson,
    /** Ревизия деревьев в движке: растёт при каждом их изменении (ключ кэша разбора). */
    revision: () => revision,
    rootId,
    checkDrive,
    status: currentStatus,
    lastError: () => lastError,
    hasPending: (id: string) => Boolean(outboxes.get(id)?.length),
    createFolder,
    share,
    unshare,
    answerInvite,
    noteRemoteDomain,
    noteOwnBlob,
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
