// Протокол v2 в web (spec 007, E2: T055/T056). Двухстековый клиент на
// переходный период: v1-стек провайдера (libolm) обслуживает v1-собеседников,
// этот контроллер — собеседников с журналом устройств v2 (WASM-движок,
// отдельный Olm-аккаунт устройства). Формат выбирается по подписанному
// журналу собеседника (D-13), не по флагам сервера.
//
// Входящие записи журнала инбокса открывает движок; содержимое перекладывается
// в WireStoredMessage и идёт в ТОТ ЖЕ конвейер отображения, что и v1
// (sync.applyExternal) — UI не знает, по какому протоколу пришло сообщение.

import type {
  WireAdminRights, WireDefaultPermissions, WireGroupInfo, WireMessageContent, WireStoredMessage,
} from '../wire';
import type { V2Content } from './contentMap';
import type { Protocol, PvClient } from './engine';
import type { StateJournalHost } from './stateJournal';

import { SecureE2eStorage } from '../secureStorage';
import {
  b64ToUuid, ref, v2Class, v2ToWire, wireToV2,
} from './contentMap';
import { loadProtocol, parseEngineError } from './engine';
import { createL2Gate, type L2State, parseL2State } from './l2';
import { CHANNEL_ANONYMOUS, CHANNEL_IDENTIFIED, V2Connection, V2Error } from './transport';

type Deps = {
  getToken: () => string;
  getSelf: () => string;
  gatewayUrl: () => string;
  /** Показать/обновить сообщение тем же конвейером, что и v1 (без v1-ack). */
  applyExternal: (stored: WireStoredMessage) => Promise<void>;
  /** История (расшифрованные строки) — чтобы мутации находили сообщения после перезагрузки. */
  loadHistory: () => Promise<WireStoredMessage[]>;
  /** В журнале устройств появились новые свои устройства (T119). */
  onNewOwnDevices: (deviceIds: string[]) => void;
  /** У аккаунта уже есть журнал устройств, а это устройство в нём не записано:
   * нужен грант линковки от своего другого устройства (LINK-1 v2). */
  onNeedsLinking?: () => void;
  /** Ключ восстановления нового корня — показать пользователю один раз. */
  onRecoveryKey: (recoveryKey: string) => void;
  /** Включён ли v2-стек (флаг): липкость D-13 действует только при нём. */
  isEnabled: () => boolean;
  /** Сервер ответил UPGRADE_REQUIRED: версия клиента ниже min_supported. */
  onUpgradeRequired: () => void;
  /** Группа v2 появилась/изменилась (сведения — из проверенного журнала). */
  onGroupUpdated: (info: WireGroupInfo, isNew: boolean) => void;
  /** Нас исключили/забанили или группа удалена. */
  onGroupLeft: (address: string) => void;
  /** FR-028 (T080): участники без подтверждённой записи администратора. */
  onUnconfirmedMembers: (address: string, members: string[]) => void;
  /** Стек поднят: журнал личного состояния (T098) можно читать. */
  onStateReady?: (host: StateJournalHost) => void;
  /** Режим «усиленная приватность» (L2) чата изменился — typing/presence и UI. */
  onL2Changed?: (address: string) => void;
  /** Своё служебное сообщение — в журнал исходящих (v2 своей операции не возвращает). */
  recordOwn?: (stored: WireStoredMessage) => void;
  log: (message: string) => void;
};

/** Сведения группы по журналу (JSON `groupInfo` движка). */
type EngineGroupInfo = {
  version: number;
  kind: number;
  name: string;
  about: string;
  avatarFileId: string;
  owner: string;
  members: { user: string; role: number; mutedUntilMs: number; rights?: WireAdminRights }[];
  banned: string[];
  epoch: number;
  epochStale: boolean;
  deleted: boolean;
  defaultPermissions?: WireDefaultPermissions;
  inviteLinks: string[];
  // Политика «усиленная приватность» (L2) и кто задал её последним
  l2?: boolean;
  l2By?: string;
};

/** Ссылка-приглашение v2, созданная на этом устройстве (секрет — в url). */
export type V2InviteRecord = {
  url: string;
  linkId: string;
  date: number;
  title?: string;
  expiresAt?: number;
  usageLimit?: number;
  isRequestNeeded?: boolean;
};

export type V2InviteCheck = {
  address: string;
  name: string;
  membersCount: number;
  isRequestNeeded: boolean;
  isChannel: boolean;
  isMember: boolean;
};

export type V2JoinResult =
  | { status: 'ok'; info: WireGroupInfo }
  | { status: 'requested' }
  | { status: 'error'; code: 'invalid' | 'banned' | 'expired' | 'rateLimited' | 'failed' };

type Chan = 'id' | 'anon';
type OutReq = { chan: Chan; method: string; body: Uint8Array };
type EngineEvent = {
  type: string;
  seq: number;
  chat?: string;
  from?: string;
  device?: string;
  opId?: string;
  tsMs?: number;
  content?: V2Content;
  disposition?: string;
  group?: { domain: string; id: string };
  json?: string;
};

const STATE_RECORD = 'v2-engine';
const INVITES_RECORD = 'v2-invites';
const V2_GROUP_PREFIX = 'v2g:';
const GROUP_KIND_GROUP = 1;
const GROUP_KIND_CHANNEL = 2;
const ROLE_NAMES: Record<number, string> = { 1: 'member', 2: 'admin', 3: 'owner' };
// Права группы по умолчанию (как у новой группы Telegram); канал — только админы
const DEFAULT_GROUP_PERMISSIONS: WireDefaultPermissions = {
  send_messages: true,
  send_media: true,
  send_stickers_gifs: true,
  send_polls: true,
  embed_links: true,
  invite_users: true,
  pin_messages: false,
  change_info: false,
};
// Смена эпохи — не чаще раза в 10 с (R8): повтор после отказа по частоте
const EPOCH_RETRY_MS = 11000;
const EPOCH_RETRY_ATTEMPTS = 6;
// Запас слепых жетонов перед раздачей ключей группы незнакомым участникам
const TOKEN_RESERVE = 2;
const GROUP_SYNC_PAGES = 50;
const OWN_DEVICES_RECORD = 'v2-own-devices';
const ROOT_BACKUP_RECORD = 'v2-root-backup';
const KEY_RECORD = 'v2-storage-key';
const OTK_COUNT = 50;
// «Не на v2» кэшируется на 10 мин; у собеседника на v2 журнал устройств
// перечитывается раз в 15 с (как каталог устройств v1): иначе его новое
// устройство не получало бы сообщений, пока само не напишет
const PEER_TTL_MS = 10 * 60 * 1000;
const PEER_LOG_REFRESH_MS = 15000;
const RECONNECT_MS = 3000;

function b64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

function unb64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function createV2Controller(deps: Deps) {
  let pv: Protocol | undefined;
  let client: PvClient | undefined;
  let storage: SecureE2eStorage | undefined;
  let storageKey: Uint8Array | undefined;
  let idConn: V2Connection | undefined;
  // C2-01: анонимные соединения выдаёт планировщик движка — по получателю
  // (серия ≤ 60 с), копии своим устройствам и служебные запросы — отдельно
  let anonPlanner: InstanceType<Protocol['PvAnonPlanner']> | undefined;
  const anonConns = new Map<number, V2Connection>();
  let serverKey: Uint8Array | undefined;
  let ready = false;
  let ownDeviceId: string | undefined;
  let starting: Promise<void> | undefined;
  // Линковка второго устройства (LINK-1 v2): журнал у аккаунта есть, грант ещё
  // не получен; материал гранта живёт в памяти только до вступления
  let needsLinking = false;
  let linkMaterial: Uint8Array | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const peers = new Map<string, { v2: boolean; at: number }>();
  const messages = new Map<string, WireStoredMessage>();
  const reactions = new Map<string, Map<string, string>>();
  // Домен сервера из описателя (группы v2 живут на нём)
  let serverDomain = '';
  // Группы, уже показанные UI (новая — с updateChatJoin)
  const publishedGroups = new Set<string>();
  const rotateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const warnedUnconfirmed = new Set<string>();
  // Режим «усиленная приватность» (L2-1): решение для typing/presence
  const l2Gate = createL2Gate({
    getSelf: deps.getSelf,
    isEnabled: deps.isEnabled,
    readEngine: readL2,
    readEnginePresence: () => (ready && client ? client.presenceAllowed() : undefined),
  });

  /** Сериализация работы с движком (один поток изменений состояния). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function persist() {
    if (!client || !storage || !storageKey) return;
    await storage.saveRecord(STATE_RECORD, b64(client.export(storageKey)));
  }

  async function call(chan: Chan, method: string, body: Uint8Array): Promise<Uint8Array> {
    if (chan === 'anon') return callAnon(method, body);
    if (!idConn) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    return idConn.request(method, body);
  }

  async function callAnon(method: string, body: Uint8Array): Promise<Uint8Array> {
    if (!pv) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    anonPlanner = anonPlanner || new pv.PvAnonPlanner();
    const now = Date.now();
    anonPlanner.expired(now).forEach((id) => closeAnon(id));
    const plan = anonPlanner.assign(method, body, now) as { conn: number; open: boolean; closeAfter: boolean };
    let conn = anonConns.get(plan.conn);
    if (plan.open || !conn?.isOpen) {
      conn?.close();
      conn = await openAnon(plan.conn);
    }
    try {
      return await conn.request(method, body);
    } finally {
      if (plan.closeAfter) closeAnon(plan.conn);
    }
  }

  async function openAnon(id: number): Promise<V2Connection> {
    const conn = new V2Connection(pv!, deps.gatewayUrl(), CHANNEL_ANONYMOUS);
    conn.onClose = () => {
      if (anonConns.get(id) !== conn) return;
      anonConns.delete(id);
      anonPlanner?.closed(id);
    };
    await conn.connect('v2');
    anonConns.set(id, conn);
    return conn;
  }

  function closeAnon(id: number) {
    const conn = anonConns.get(id);
    anonConns.delete(id);
    anonPlanner?.closed(id);
    conn?.close();
  }

  async function run(reqs: OutReq[]) {
    for (const r of reqs) {
      await call(r.chan, r.method, r.body);
    }
  }

  /** Добрать то, чего не хватило движку (журнал/бандл/жетоны), и повторить. */
  async function satisfy(e: unknown): Promise<boolean> {
    const err = parseEngineError(e);
    if (!('need' in err)) return false;
    const { need } = err;
    if (!pv || !client) return false;
    switch (need.kind) {
      case 'peerLog': {
        const user = need.user!;
        const body = pv.encodeMessage('parvane.identity.v2.DeviceLogSyncAnonRequest', JSON.stringify({
          user: { address: user }, after_version: String(client.logVersion(user)),
        }));
        const resp = await call('anon', 'identity.device.log_sync_anon', body);
        const verdict = client.ingestLog(user, resp);
        if (verdict === 'rootChanged') deps.log(`v2: у ${user} сменился корневой ключ — нужно подтверждение`);
        return verdict !== 'rootChanged';
      }
      case 'bundle': {
        const user = need.user!;
        const body = pv.encodeMessage(
          'parvane.identity.v2.DeviceFetchBundleAnonRequest', JSON.stringify({ user: { address: user } }),
        );
        const resp = await call('anon', 'identity.device.fetch_bundle_anon', body);
        client.ingestBundle(user, resp);
        return true;
      }
      case 'token': {
        if (!serverKey) return false;
        const list = await call('anon', 'identity.tokens.key_list', new Uint8Array());
        const req = client.tokenRequest(list, serverKey, 20) as OutReq;
        const resp = await call(req.chan, req.method, req.body);
        client.tokenResponse(resp);
        return true;
      }
      case 'groupLog': {
        const before = client.groupVersion(need.group!);
        await syncGroup(need.group!);
        // Сервер не отдал новых записей — повтор не поможет (удержание хвоста, D-03)
        return client.groupVersion(need.group!) !== before || client.groupBehind(need.group!) === undefined;
      }
      case 'groupKeys': {
        // Ключей эпохи нет: админ начинает новую эпоху сам, участник ждёт её
        if (!canRotate(need.group!)) return false;
        await rotateEpoch(need.group!);
        return true;
      }
      default:
        return false;
    }
  }

  async function withNeeds<T>(fn: () => T): Promise<T> {
    for (let i = 0; i < 6; i++) {
      try {
        return fn();
      } catch (e) {
        if (!(await satisfy(e))) throw e;
      }
    }
    throw new Error('v2: данные не сошлись');
  }

  // ── запуск ────────────────────────────────────────────────────────────────

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      const self = deps.getSelf();
      const token = deps.getToken();
      if (!self || !token) return;
      pv = await loadProtocol();
      storage = await SecureE2eStorage.open(self);
      const savedKey = await storage.loadRecord<string>(KEY_RECORD);
      storageKey = savedKey ? unb64(savedKey) : crypto.getRandomValues(new Uint8Array(32));
      if (!savedKey) await storage.saveRecord(KEY_RECORD, b64(storageKey));

      idConn = new V2Connection(pv, deps.gatewayUrl(), CHANNEL_IDENTIFIED);
      const welcome = await idConn.connect('v2');
      const desc = JSON.parse(pv.verifyServerDescriptor(welcome.serverDescriptor)) as {
        domain: string; serverKey: string;
      };
      serverKey = Uint8Array.from(desc.serverKey.match(/../g)!.map((h) => parseInt(h, 16)));
      serverDomain = desc.domain;
      const auth = await idConn.auth(token);
      ownDeviceId = auth.deviceId;
      idConn.onEvent = (ev) => {
        if (ev.eventKind === 'inbox.record') void serial(() => openRecord(ev.body));
        if (ev.eventKind === 'session.revoked') deps.log('v2: сессия отозвана');
      };
      idConn.onClose = () => {
        ready = false;
        starting = undefined;
        setTimeout(() => {
          void start().catch(() => undefined);
        }, RECONNECT_MS);
      };

      // Прежние версии хранили корень открыто (C1-06) — стираем
      await storage.deleteRecord('v2-root').catch(() => undefined);
      const saved = await storage.loadRecord<string>(STATE_RECORD);
      if (saved) {
        client = pv.PvClient.importState(unb64(saved), storageKey);
      } else {
        client = new pv.PvClient(self, auth.deviceId, desc.domain);
        // Первое v2-устройство пользователя — корень и журнал устройств.
        // Если у пользователя уже есть журнал (другое устройство на v2) —
        // этому устройству нужна линковка (LINK-1 v2); до неё — только v1.
        // Свой журнал — ID-каналом: анонимность себе не нужна, а анонимный
        // запрос о себе связал бы соединение с пользователем (C2-01)
        const ownLog = await call('id', 'identity.device.log_sync', pv.encodeMessage(
          'parvane.identity.v2.DeviceLogSyncRequest',
          JSON.stringify({ user: { address: self }, after_version: '0' }),
        ));
        if (pv.deviceLogEntries(ownLog) > 0) {
          if (!linkMaterial) {
            deps.log('v2: у аккаунта уже есть журнал устройств — нужна линковка этого устройства');
            client.free();
            client = undefined;
            needsLinking = true;
            deps.onNeedsLinking?.();
            return;
          }
          // Грант от своего устройства: SSK, журнал, ключ доставки и ключ личного
          // состояния — устройство сертифицирует себя записью журнала (D-11)
          const material = linkMaterial;
          linkMaterial = undefined;
          try {
            await run(client.joinWithGrant(material, OTK_COUNT) as OutReq[]);
          } finally {
            material.fill(0);
          }
          needsLinking = false;
          await persist();
          deps.log('v2: устройство привязано грантом линковки');
        } else {
          const created = client.createIdentity(OTK_COUNT) as { requests: OutReq[]; rootSecret: Uint8Array };
          await run(created.requests);
          // C1-06 / D-12: корень не лежит на устройстве — только копия под ключом
          // восстановления (≥ 128 бит, без парольной фразы), ключ показывается
          // пользователю один раз
          const recoveryKey = pv.generateRecoveryKey();
          const backup = client.exportRootBackup(recoveryKey, created.rootSecret);
          await storage.saveRecord(ROOT_BACKUP_RECORD, b64(backup));
          client.forgetRoot();
          created.rootSecret.fill(0);
          deps.onRecoveryKey(recoveryKey);
          await persist();
        }
      }
      // Ключ личного состояния (T098): первое v2-устройство создаёт его;
      // связанное получает от своего устройства (StateKeyShare)
      const ownDevices = (JSON.parse(client.logDevices(self)) as { v2: string[] }).v2;
      if (!client.hasStateKey() && ownDevices.length <= 1 && client.ensureStateKey()) await persist();
      await call('id', 'msg.inbox.subscribe', new Uint8Array());
      ready = true;
      // Группы v2 из состояния движка — в UI до разбора инбокса
      client.groupList().forEach((hex) => publishGroup(hex));
      await serial(syncAll);
      // L2-1: до готовности движка решение о typing/presence бралось из памяти
      l2Gate.reconcile([...loadStickyPeers(), ...publishedGroups])
        .forEach((address) => deps.onL2Changed?.(address));
      deps.log('v2: готов');
      deps.onStateReady?.(stateHost);
      void checkOwnDevices().catch((e: unknown) => deps.log(`v2: журнал своих устройств: ${String(e)}`));
    })().catch((e: unknown) => {
      starting = undefined;
      deps.log(`v2: запуск не удался: ${String(e)}`);
      // Сервер больше не принимает эту версию протокола (Welcome не пришёл)
      if (e instanceof V2Error && e.code === 'ERROR_CODE_UPGRADE_REQUIRED') deps.onUpgradeRequired();
    });
    return starting;
  }

  async function syncAll() {
    if (!client || !pv) return;
    for (let page = 0; page < 1000; page++) {
      const req = client.syncRequest() as OutReq;

      const resp = await call(req.chan, req.method, req.body);
      const batch = pv.splitSyncResponse(resp) as { records: Uint8Array[]; more: boolean };
      for (const r of batch.records) {
        await openRecord(r);
      }
      if (!batch.more || !batch.records.length) break;
    }
    const ack = client.ackRequest() as OutReq;
    await call(ack.chan, ack.method, ack.body).catch(() => undefined);
    await persist();
  }

  async function openRecord(bytes: Uint8Array) {
    if (!client) return;
    let events: EngineEvent[] = [];
    for (let i = 0; i < 6; i++) {
      try {
        events = JSON.parse(client.openRecord(bytes)) as EngineEvent[];
        break;
      } catch (e) {
        if (!(await satisfy(e).catch(() => false))) {
          deps.log(`v2: запись не открыта: ${String(e)}`);
          return;
        }
      }
    }
    for (const ev of events) {
      await applyEvent(ev);
    }
    const err = client.lastError();
    if (err) deps.log(`v2: ошибка записи: ${err}`);
    await persist();
  }

  // ── приём: событие движка → строка конвейера UI ──────────────────────────

  async function knownMessage(uuid: string): Promise<WireStoredMessage | undefined> {
    const hit = messages.get(uuid);
    if (hit) return hit;
    const history = await deps.loadHistory();
    const found = history.find((h) => h.id === uuid);
    if (found) messages.set(uuid, found);
    return found;
  }

  async function update(uuid: string, patch: (m: WireStoredMessage) => WireStoredMessage) {
    const m = await knownMessage(uuid);
    if (!m) return;
    const next = patch(m);
    messages.set(uuid, next);
    await deps.applyExternal(next);
  }

  function reactionList(uuid: string) {
    const byUser = reactions.get(uuid);
    if (!byUser) return [];
    const counts = new Map<string, { count: number; mine: boolean }>();
    byUser.forEach((emoji, user) => {
      const c = counts.get(emoji) || { count: 0, mine: false };
      c.count += 1;
      if (user === deps.getSelf()) c.mine = true;
      counts.set(emoji, c);
    });
    return Array.from(counts, ([emoji, c]) => ({ emoji, count: c.count, mine: c.mine }));
  }

  async function applyEvent(ev: EngineEvent) {
    if (ev.type === 'groupChanged' && ev.group) {
      await syncGroup(ev.group.id);
      return;
    }
    const isGroup = ev.type === 'group' && Boolean(ev.group);
    if ((ev.type === 'direct' || isGroup) && ev.content && ev.opId && ev.from) {
      const self = deps.getSelf();
      const chat = ev.chat || ev.from;
      const c = ev.content;
      const author = ev.from;
      // Группа: сообщение кладётся в чат группы, автор — из проверенной подписи
      const to = isGroup ? groupAddress(ev.group!.id) : (author === self ? chat : self);
      if (ev.disposition === 'stub') {
        const stub: WireStoredMessage = {
          id: ev.opId, from: author, to, ts: Math.floor((ev.tsMs || 0) / 1000), content: { kind: 'unsupported' },
        };
        messages.set(ev.opId, stub);
        await deps.applyExternal(stub);
        return;
      }
      if (c.edit?.target) {
        const target = b64ToUuid(c.edit.target.op_id);
        if (target) {
          await update(target, (m) => {
            if (m.from !== author) return m;
            const content = { ...m.content };
            if (c.edit!.text) {
              const t = v2ToWire({ text: c.edit!.text })!;
              if (content.kind === 'text') {
                Object.assign(content, { text: t.text, entities: t.entities, webpage: t.webpage });
              } else {
                Object.assign(content, { caption: t.text, entities: t.entities });
              }
            }
            if (c.edit!.location) Object.assign(content, v2ToWire({ location: c.edit!.location }));
            return { ...m, content, edited: true };
          });
        }
        return;
      }
      if (c.delete?.targets) {
        for (const t of c.delete.targets) {
          const target = b64ToUuid(t.op_id);

          if (target) await update(target, (m) => (m.from === author ? { ...m, deleted: true } : m));
        }
        return;
      }
      if (c.reaction?.target) {
        const target = b64ToUuid(c.reaction.target.op_id);
        if (target) {
          const byUser = reactions.get(target) || new Map<string, string>();
          if (c.reaction.remove || !c.reaction.emoji) byUser.delete(author);
          else byUser.set(author, c.reaction.emoji);
          reactions.set(target, byUser);
          await update(target, (m) => ({ ...m, reactions: reactionList(target) }));
        }
        return;
      }
      if (c.pin?.target) {
        const target = b64ToUuid(c.pin.target.op_id);
        if (target) await update(target, (m) => ({ ...m, pinned: !c.pin!.unpin }));
        return;
      }
      if (c.receipt?.messages) {
        if (c.receipt.kind === 'RECEIPT_KIND_READ') {
          for (const t of c.receipt.messages) {
            const target = b64ToUuid(t.op_id);

            if (target) await update(target, (m) => ({ ...m, read: true }));
          }
        }
        return;
      }
      // Вид, который клиент не умеет показать (например, контакт), — заглушка,
      // как в desktop и android; служебные виды движка в чат не попадают
      const wire = v2ToWire(c) || (v2Class(c) === 'stub' ? { kind: 'unsupported' } : undefined);
      if (!wire) return;
      // Режим L2 группы задаёт только запись её журнала (`set_privacy_mode`)
      if (c.chat_mode && isGroup) return;
      const stored: WireStoredMessage = {
        id: ev.opId,
        from: author,
        to,
        ts: Math.floor((ev.tsMs || Date.now()) / 1000),
        content: wire,
        reply_to: b64ToUuid(c.reply_to?.op_id),
      };
      messages.set(ev.opId, stored);
      await deps.applyExternal(stored);
      // Собеседник (или своё другое устройство) сменил режим L2 личного чата
      if (c.chat_mode) announceL2(author === self ? chat : author);
      return;
    }
    if (ev.type === 'deviceAdded') await checkOwnDevices();
    // Своё устройство передало (новый) ключ личного состояния — журнал заново
    if (ev.type === 'stateKeyRotated') deps.onStateReady?.(stateHost);
  }

  // Новое своё устройство (T119): свой журнал устройств — источник истины,
  // живое событие `deviceAdded` лишь ускоряет проверку; офлайн-вкладка
  // узнаёт о новом устройстве при следующем запуске
  async function checkOwnDevices() {
    if (!pv || !client || !storage) return;
    const self = deps.getSelf();
    const resp = await call('id', 'identity.device.log_sync', pv.encodeMessage(
      'parvane.identity.v2.DeviceLogSyncRequest',
      JSON.stringify({ user: { address: self }, after_version: String(client.logVersion(self)) }),
    ));
    client.ingestLog(self, resp);
    const current = (JSON.parse(client.logDevices(self)) as { v2: string[] }).v2;
    const known = await storage.loadRecord<string[]>(OWN_DEVICES_RECORD);
    await storage.saveRecord(OWN_DEVICES_RECORD, current);
    await persist();
    // Первая проверка на этом устройстве — запоминаем, не уведомляем
    if (!known) return;
    const added = current.filter((id) => !known.includes(id) && id !== ownDeviceId);
    if (added.length) deps.onNewOwnDevices(added);
  }

  // ── маршрутизация ─────────────────────────────────────────────────────────

  /** Собеседник на v2? (есть журнал устройств; кэш 10 мин). */
  async function isV2Peer(address: string): Promise<boolean> {
    if (address === deps.getSelf() || isV2GroupAddress(address)) return false;
    // D-13 (C2-02): собеседник, однажды замеченный на v2, по v1 больше не
    // получает — иначе сервер, оборвав v2-соединение, увидел бы отправителя.
    // v2 недоступен → ошибка отправки, а не тихий откат
    const isSticky = deps.isEnabled() && loadStickyPeers().has(address);
    // Стек ещё поднимается (сразу после входа) — дождаться, а не отказать
    if (isSticky && !ready && starting) await starting.catch(() => undefined);
    if (!ready || !client || !pv) {
      if (isSticky) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      return false;
    }
    const hit = peers.get(address);
    if (hit && Date.now() - hit.at < (hit.v2 ? PEER_LOG_REFRESH_MS : PEER_TTL_MS)) return hit.v2 || isSticky;
    try {
      const v2 = await serial(async () => {
        const before = client!.logVersion(address);
        try {
          await satisfy(JSON.stringify({ need: { kind: 'peerLog', user: address } }));
        } catch (e) {
          if (before === 0n) throw e;
          deps.log(`v2: журнал ${address} не обновлён: ${String(e)}`);
        }
        if (client!.logVersion(address) !== before) await persist();
        return client!.logVersion(address) > 0n;
      });
      peers.set(address, { v2, at: Date.now() });
      if (v2) rememberStickyPeer(address);
      return v2 || isSticky;
    } catch (e) {
      if (isSticky) throw e;
      return false;
    }
  }

  function stickyKey() {
    return `parvane:v2peers:${deps.getSelf()}`;
  }

  function loadStickyPeers(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(stickyKey()) || '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  function rememberStickyPeer(address: string) {
    const known = loadStickyPeers();
    if (known.has(address)) return;
    known.add(address);
    try {
      localStorage.setItem(stickyKey(), JSON.stringify([...known]));
    } catch {
      // приватный режим — липкость живёт до перезагрузки (peers в памяти)
    }
  }

  async function sendContent(to: string, content: V2Content, uuid: string) {
    await serial(async () => {
      if (isV2GroupAddress(to)) {
        const hex = groupHex(to);
        await ensureTokens(groupMembers(hex).length);
        const reqs = await withNeeds(() => client!.prepareGroup(hex, JSON.stringify(content), uuid) as OutReq[]);
        await run(reqs);
      } else {
        const reqs = await withNeeds(() => client!.prepareDirect(to, JSON.stringify(content), uuid) as OutReq[]);
        await run(reqs);
      }
      await persist();
    });
  }

  /** Чат идёт по v2: группа v2 или собеседник с журналом устройств v2. */
  async function isV2Chat(address: string) {
    if (isV2GroupAddress(address)) {
      if (!ready && starting) await starting.catch(() => undefined);
      if (!ready || !client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      return true;
    }
    return isV2Peer(address);
  }

  /** Отправить сообщение v2-собеседнику. Возвращает false — не v2 (идти по v1). */
  async function trySend(to: string, wire: WireMessageContent, uuid: string, replyTo?: string): Promise<boolean> {
    if (!(await isV2Chat(to))) return false;
    await sendContent(to, wireToV2(wire, replyTo), uuid);
    const stored: WireStoredMessage = {
      id: uuid, from: deps.getSelf(), to, ts: Math.floor(Date.now() / 1000), content: wire, reply_to: replyTo,
    };
    messages.set(uuid, stored);
    return true;
  }

  async function tryEdit(to: string, uuid: string, wire: WireMessageContent): Promise<boolean> {
    if (!(await isV2Chat(to))) return false;
    const edit: V2Content['edit'] = { target: ref(uuid) };
    if (wire.kind === 'location') edit.location = wireToV2(wire).location;
    else {
      edit.text = {
        text: wire.kind === 'text' ? wire.text : wire.caption,
        entities: wireToV2({ kind: 'text', text: '', entities: wire.entities }).text?.entities,
      };
    }
    await sendMutation(to, { edit });
    return true;
  }

  async function tryMutation(to: string, content: V2Content): Promise<boolean> {
    if (!(await isV2Chat(to))) return false;
    await sendMutation(to, content);
    return true;
  }

  // Своя мутация применяется локально тем же путём, что и входящая: у v2 нет
  // серверной v1-строки, которую догнал бы синк, — иначе после перезагрузки
  // кэш истории показывал бы сообщение до правки
  async function sendMutation(to: string, content: V2Content) {
    const opId = newV7();
    await sendContent(to, content, opId);
    const group = isV2GroupAddress(to) ? { domain: serverDomain, id: groupHex(to) } : undefined;
    await applyEvent({
      type: group ? 'group' : 'direct', seq: 0, chat: to, from: deps.getSelf(), opId, tsMs: Date.now(), content, group,
    });
  }

  // ── режим «усиленная приватность» (L2, FR-036, T079) ───────────────────────
  // Личный чат: подписанное предпочтение участника (операция `ChatMode`),
  // режим активен, пока он включён хотя бы у одного. Группа: политика в
  // журнале группы. Размеры конвертов выравнивает движок; на клиенте —
  // typing/presence (правило L2-1) и служебное сообщение чата.

  function readL2(address: string): L2State | undefined {
    if (!ready || !client) return undefined;
    try {
      return parseL2State(isV2GroupAddress(address) ? client.l2Group(groupHex(address)) : client.l2Direct(address));
    } catch {
      return undefined;
    }
  }

  function announceL2(address: string) {
    l2Gate.state(address);
    deps.onL2Changed?.(address);
  }

  /** Своё предпочтение в личном чате. false — собеседник не на v2. */
  async function setDirectL2(peer: string, enabled: boolean): Promise<boolean> {
    if (isV2GroupAddress(peer) || !(await isV2Peer(peer))) return false;
    const opId = newV7();
    try {
      await serial(async () => {
        const reqs = await withNeeds(() => client!.l2SetDirect(peer, enabled, opId) as OutReq[]);
        await run(reqs);
        await persist();
      });
    } finally {
      // Предпочтение движок меняет до отправки: UI перечитывает состояние и при сбое
      announceL2(peer);
    }
    // v2 своей операции назад не присылает: служебное сообщение показываем
    // сами и кладём в журнал исходящих — оно переживает перезагрузку
    const stored: WireStoredMessage = {
      id: opId,
      from: deps.getSelf(),
      to: peer,
      ts: Math.floor(Date.now() / 1000),
      content: { kind: 'chat_mode', l2: enabled },
    };
    messages.set(opId, stored);
    await deps.applyExternal(stored);
    deps.recordOwn?.(stored);
    return true;
  }

  /** Политика группы — записью её журнала; право как у изменения сведений. */
  function setGroupL2(address: string, enabled: boolean) {
    return changeGroup(address, { set_privacy_mode: { l2: enabled } });
  }

  // Политика L2 группы сменилась по журналу — служебное сообщение в чате
  // группы от имени того, кто её задал. Последнее известное значение хранится
  // в памяти режима (localStorage): после перезагрузки сообщение не повторяется
  function noteGroupL2(hex: string, g: EngineGroupInfo) {
    const address = groupAddress(hex);
    const isEnabled = Boolean(g.l2);
    if (!l2Gate.noteGroupPolicy(address, isEnabled)) return;
    announceL2(address);
    const stored: WireStoredMessage = {
      id: newV7(),
      from: g.l2By || g.owner,
      to: address,
      ts: Math.floor(Date.now() / 1000),
      content: { kind: 'chat_mode', l2: isEnabled },
    };
    messages.set(stored.id, stored);
    void deps.applyExternal(stored)
      .then(() => {
        if (stored.from === deps.getSelf()) deps.recordOwn?.(stored);
      })
      .catch((e: unknown) => deps.log(`v2: служебное сообщение о режиме группы не показано: ${String(e)}`));
  }

  // ── группы v2 (R8, T056/T073/T125) ─────────────────────────────────────────
  // Состав, роли, права и ссылки — из подписанного журнала группы, который
  // проверяет движок; UI получает синтетический WireGroupInfo через тот же
  // store.registerGroup, что и v1-группы. Адрес группы в UI — `v2g:<hex id>`.

  function groupRequestBody(hex: string, after: bigint | number, linkId?: string) {
    return pv!.encodeMessage('parvane.group.v2.StateSyncRequest', JSON.stringify({
      group: { domain: serverDomain, id: hexToB64(hex) },
      after_version: String(after),
      invite_link_id: linkId ? hexToB64(linkId) : undefined,
    }));
  }

  /** Догнать журнал группы (записи после своей версии) и применить отложенное. */
  async function syncGroup(hex: string, linkId?: string) {
    if (!client || !pv) return;
    for (let page = 0; page < GROUP_SYNC_PAGES; page++) {
      const before = client.groupVersion(hex);
      const resp = await call('id', 'group.state.sync', groupRequestBody(hex, before, linkId));
      await withNeeds(() => client!.groupIngest(serverDomain, hex, resp));
      if (client.groupVersion(hex) === before) break;
    }
    // Чат группы — до отложенных сообщений (иначе они легли бы не в тот чат)
    publishGroup(hex);
    const pending = JSON.parse(client.drainReady()) as EngineEvent[];
    for (const ev of pending) {
      await applyEvent(ev);
    }
  }

  /** Локальная запись журнала отвергнута сервером — состояние заново с сервера. */
  async function resyncGroup(hex: string) {
    client?.groupForget(hex);
    await syncGroup(hex).catch((e: unknown) => deps.log(`v2: журнал группы ${hex} не перечитан: ${String(e)}`));
  }

  function readGroup(hex: string): EngineGroupInfo | undefined {
    if (!client) return undefined;
    try {
      return JSON.parse(client.groupInfo(hex)) as EngineGroupInfo;
    } catch {
      return undefined;
    }
  }

  function groupMembers(hex: string) {
    return readGroup(hex)?.members.map(({ user }) => user) || [];
  }

  function toWireGroupInfo(hex: string, g: EngineGroupInfo): WireGroupInfo {
    return {
      group_id: groupAddress(hex),
      name: g.name,
      kind: g.kind === GROUP_KIND_CHANNEL ? 'channel' : 'group',
      created_by: g.owner,
      members: [
        ...g.members.map((m) => ({
          address: m.user,
          role: ROLE_NAMES[m.role] || 'member',
          admin_rights: m.role === 2 ? (m.rights || {}) : undefined,
        })),
        ...g.banned.map((address) => ({ address, role: 'banned' })),
      ],
      avatar: g.avatarFileId || undefined,
      about: g.about || undefined,
      default_permissions: g.defaultPermissions || {},
      version: Number(g.version),
    };
  }

  function canRotate(hex: string) {
    const g = readGroup(hex);
    const self = deps.getSelf();
    const me = g?.members.find(({ user }) => user === self);
    return Boolean(g && !g.deleted && me && (me.role === 2 || me.role === 3));
  }

  /** Показать группу UI; админ начинает новую эпоху после смены состава/прав. */
  function publishGroup(hex: string) {
    if (!client) return;
    const g = readGroup(hex);
    if (!g) return;
    const info = toWireGroupInfo(hex, g);
    const address = info.group_id;
    const self = deps.getSelf();
    const isMember = g.members.some(({ user }) => user === self);
    saveGroupCache(info, isMember && !g.deleted);
    if (!isMember || g.deleted) {
      if (publishedGroups.delete(address)) deps.onGroupLeft(address);
      l2Gate.forget(address);
      return;
    }
    const isNew = !publishedGroups.has(address);
    publishedGroups.add(address);
    deps.onGroupUpdated(info, isNew);
    reportUnconfirmed(hex, []);
    noteGroupL2(hex, g);
    // Новую эпоху начинает владелец (или админ, сделавший изменение, — сразу)
    if (g.epochStale && g.owner === self) scheduleRotate(hex, 0);
  }

  function reportUnconfirmed(hex: string, claimed: string[]) {
    if (!client) return;
    const fresh = client.groupUnconfirmed(hex, claimed)
      .filter((member) => !warnedUnconfirmed.has(`${hex}:${member}`));
    if (!fresh.length) return;
    fresh.forEach((member) => warnedUnconfirmed.add(`${hex}:${member}`));
    deps.log(`v2: в группе ${hex} участники без подтверждённой записи администратора: ${fresh.join(', ')}`);
    deps.onUnconfirmedMembers(groupAddress(hex), fresh);
  }

  /** Жетоны на раздачу ключей незнакомым участникам — до операции движка. */
  async function ensureTokens(recipients: number) {
    if (!client || !serverKey || client.tokenCount() >= recipients + TOKEN_RESERVE) return;
    await satisfy(JSON.stringify({ need: { kind: 'token' } })).catch(() => false);
  }

  /** Новая эпоха (админ): ключ отправки — в журнал, ключи эпохи — участникам по E2E. */
  async function rotateEpoch(hex: string) {
    try {
      await rotateEpochOnce(hex);
    } catch (e) {
      // Эпоха не чаще раза в 10 с (часы движка и сервера): подождать и
      // повторить один раз — отправка сразу после бана/вступления иначе упала бы
      if (!isRateLimited(e)) throw e;
      await pause(EPOCH_RETRY_MS);
      await rotateEpochOnce(hex);
    }
  }

  async function rotateEpochOnce(hex: string) {
    await ensureTokens(groupMembers(hex).length);
    const reqs = await withNeeds(() => client!.groupRotateEpoch(hex) as OutReq[]);
    const [publish, ...shares] = reqs;
    try {
      await call(publish.chan, publish.method, publish.body);
    } catch (e) {
      await resyncGroup(hex);
      throw e;
    }
    for (const r of shares) {
      await call(r.chan, r.method, r.body)
        .catch((e: unknown) => deps.log(`v2: ключи эпохи не доставлены: ${String(e)}`));
    }
    await persist();
    deps.log(`v2: новая эпоха группы ${hex}: ${readGroup(hex)?.epoch}`);
  }

  function scheduleRotate(hex: string, delayMs: number, attempt = 0) {
    if (rotateTimers.has(hex)) return;
    rotateTimers.set(hex, setTimeout(() => {
      rotateTimers.delete(hex);
      void serial(async () => {
        const g = readGroup(hex);
        if (!g?.epochStale || !canRotate(hex)) return;
        await rotateEpoch(hex);
        publishGroup(hex);
      }).catch((e: unknown) => {
        deps.log(`v2: новая эпоха группы ${hex} не начата: ${String(e)}`);
        if (attempt < EPOCH_RETRY_ATTEMPTS) scheduleRotate(hex, EPOCH_RETRY_MS, attempt + 1);
      });
    }, delayMs));
  }

  /** Создать группу на v2, если стек поднят и ВСЕ участники — v2 (иначе undefined → v1). */
  async function createGroup(title: string, members: string[], kind: 'group' | 'channel') {
    if (!ready || !client || !pv) return undefined;
    for (const member of members) {
      if (!(await isV2Peer(member).catch(() => false))) return undefined;
    }
    return serial(async () => {
      const perms = kind === 'channel' ? {} : DEFAULT_GROUP_PERMISSIONS;
      const known = new Set(client!.groupList());
      const created = client!.groupCreate(
        kind === 'channel' ? GROUP_KIND_CHANNEL : GROUP_KIND_GROUP, title, members, JSON.stringify(perms),
      ) as { request: OutReq };
      const hex = client!.groupList().find((id) => !known.has(id))!;
      try {
        await call(created.request.chan, created.request.method, created.request.body);
      } catch (e) {
        client!.groupForget(hex);
        throw e;
      }
      await rotateEpoch(hex).catch((e: unknown) => {
        deps.log(`v2: первая эпоха группы не начата: ${String(e)}`);
        scheduleRotate(hex, EPOCH_RETRY_MS);
      });
      await persist();
      deps.log(`v2: группа создана ${hex} (${members.length + 1} участников)`);
      const g = readGroup(hex)!;
      publishedGroups.add(groupAddress(hex));
      const info = toWireGroupInfo(hex, g);
      saveGroupCache(info, true);
      return info;
    });
  }

  /** Изменение группы записью журнала (proto3-JSON `group.v2.GroupChange`). */
  async function changeGroup(address: string, change: Record<string, unknown>) {
    if (!ready || !client || !isV2GroupAddress(address)) return false;
    const hex = groupHex(address);
    return serial(async () => {
      let req: OutReq;
      try {
        req = client!.groupChange(hex, JSON.stringify(change)) as OutReq;
      } catch (e) {
        deps.log(`v2: изменение группы отклонено движком: ${String(e)}`);
        return false;
      }
      try {
        await call(req.chan, req.method, req.body);
      } catch (e) {
        deps.log(`v2: изменение группы отклонено сервером: ${String(e)}`);
        await resyncGroup(hex);
        return false;
      }
      // Состав/права изменились — ключи прежней эпохи мог держать исключённый
      if (readGroup(hex)?.epochStale && canRotate(hex)) {
        await rotateEpoch(hex).catch((e: unknown) => {
          deps.log(`v2: новая эпоха после изменения не начата: ${String(e)}`);
          scheduleRotate(hex, EPOCH_RETRY_MS);
        });
      }
      await persist();
      publishGroup(hex);
      return true;
    });
  }

  function groupInfo(address: string): WireGroupInfo | undefined {
    if (!client || !isV2GroupAddress(address)) return undefined;
    const hex = groupHex(address);
    const g = readGroup(hex);
    return g ? toWireGroupInfo(hex, g) : undefined;
  }

  // Сведения v2-групп для UI до подъёма движка (история из кэша кладётся в
  // чат группы, только если группа уже зарегистрирована). Только метаданные
  function groupCacheKey() {
    return `parvane:v2groups:${deps.getSelf()}`;
  }

  function cachedGroups(): WireGroupInfo[] {
    try {
      return JSON.parse(localStorage.getItem(groupCacheKey()) || '[]') as WireGroupInfo[];
    } catch {
      return [];
    }
  }

  function saveGroupCache(info: WireGroupInfo, isListed: boolean) {
    const rest = cachedGroups().filter(({ group_id: id }) => id !== info.group_id);
    try {
      localStorage.setItem(groupCacheKey(), JSON.stringify(isListed ? [...rest, info] : rest));
    } catch {
      // квота/приватный режим — группы появятся после подъёма движка
    }
  }

  // ── ссылки-приглашения v2 (D-04, T084/T125) ─────────────────────────────────

  async function loadInvites(): Promise<Record<string, V2InviteRecord[]>> {
    return (await storage?.loadRecord<Record<string, V2InviteRecord[]>>(INVITES_RECORD)) || {};
  }

  async function listInvites(address: string): Promise<V2InviteRecord[]> {
    if (!client || !isV2GroupAddress(address)) return [];
    const active = new Set(readGroup(groupHex(address))?.inviteLinks || []);
    return ((await loadInvites())[address] || []).filter(({ linkId }) => active.has(linkId));
  }

  async function createInvite(address: string, params: {
    title?: string; expireDate?: number; usageLimit?: number; isRequestNeeded?: boolean;
  }): Promise<V2InviteRecord | undefined> {
    if (!ready || !client || !isV2GroupAddress(address)) return undefined;
    const hex = groupHex(address);
    return serial(async () => {
      let created: { request: OutReq; url: string; linkId: string };
      try {
        created = client!.groupInviteCreate(
          hex, params.title || '', (params.expireDate || 0) * 1000, params.usageLimit || 0,
          Boolean(params.isRequestNeeded),
        ) as typeof created;
      } catch (e) {
        deps.log(`v2: ссылка не создана движком: ${String(e)}`);
        return undefined;
      }
      try {
        await call(created.request.chan, created.request.method, created.request.body);
      } catch (e) {
        deps.log(`v2: ссылка не принята сервером: ${String(e)}`);
        await resyncGroup(hex);
        return undefined;
      }
      const record: V2InviteRecord = {
        url: created.url,
        linkId: created.linkId,
        date: Math.floor(Date.now() / 1000),
        title: params.title || undefined,
        expiresAt: params.expireDate || undefined,
        usageLimit: params.usageLimit || undefined,
        isRequestNeeded: params.isRequestNeeded || undefined,
      };
      const all = await loadInvites();
      all[address] = [...(all[address] || []), record];
      await storage?.saveRecord(INVITES_RECORD, all);
      await persist();
      publishGroup(hex);
      return record;
    });
  }

  async function revokeInvite(address: string, url: string) {
    const record = (await loadInvites())[address]?.find((item) => item.url === url);
    if (!record) return false;
    return changeGroup(address, { invite_key_revoke: { link_id: hexToB64(record.linkId) } });
  }

  function parseV2Invite(url: string): { domain: string; linkId: string } | undefined {
    if (!pv) return undefined;
    try {
      const parsed = JSON.parse(pv.parseInvite(url)) as { kind: string; domain?: string; linkId?: string };
      return parsed.kind === 'v2' ? { domain: parsed.domain!, linkId: parsed.linkId! } : undefined;
    } catch {
      return undefined;
    }
  }

  function inviteErrorCode(e: unknown): 'invalid' | 'banned' | 'expired' | 'rateLimited' | 'failed' {
    const code = e instanceof V2Error ? e.code : String(e);
    if (code.includes('NOT_FOUND') || code.includes('FORBIDDEN')) return 'invalid';
    if (code.includes('BANNED')) return 'banned';
    if (code.includes('EXPIRED')) return 'expired';
    if (code.includes('RATE')) return 'rateLimited';
    return 'failed';
  }

  async function inviteGroup(linkId: string) {
    if (!pv) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const resp = await call('id', 'group.invite.check', pv.encodeMessage(
      'parvane.group.v2.InviteCheckRequest', JSON.stringify({ link_id: hexToB64(linkId) }),
    ));
    return JSON.parse(pv.decodeMessage('parvane.group.v2.InviteCheckResponse', resp)) as {
      group?: { domain: string; id: string }; name?: string; members?: number; requires_approval?: boolean;
      kind?: string;
    };
  }

  /** Превью ссылки v2 до вступления. undefined — не v2-ссылка или стек не поднят. */
  async function checkInvite(url: string): Promise<V2InviteCheck | { error: V2JoinResult } | undefined> {
    if (!ready && starting) await starting.catch(() => undefined);
    const parsed = parseV2Invite(url);
    if (!ready || !client || !parsed) return undefined;
    try {
      const check = await inviteGroup(parsed.linkId);
      const hex = b64ToHex(check.group?.id || '');
      const self = deps.getSelf();
      return {
        address: groupAddress(hex),
        name: check.name || '',
        membersCount: check.members || 0,
        isRequestNeeded: Boolean(check.requires_approval),
        isChannel: check.kind === 'GROUP_KIND_CHANNEL',
        isMember: Boolean(readGroup(hex)?.members.some(({ user }) => user === self)),
      };
    } catch (e) {
      return { error: { status: 'error', code: inviteErrorCode(e) } };
    }
  }

  /** Вступить по ссылке v2: журнал по link_id, запись, подписанная ключом ссылки. */
  async function joinByInvite(url: string): Promise<V2JoinResult | undefined> {
    const parsed = parseV2Invite(url);
    if (!ready || !client || !parsed) return undefined;
    try {
      const check = await inviteGroup(parsed.linkId);
      const hex = b64ToHex(check.group?.id || '');
      return await serial(async () => {
        await syncGroup(hex, parsed.linkId);
        const req = client!.groupJoin(url) as OutReq;
        let resp: Uint8Array;
        try {
          resp = await call(req.chan, req.method, req.body);
        } catch (e) {
          await resyncGroup(hex).catch(() => undefined);
          throw e;
        }
        if (!pv) throw new V2Error('ERROR_CODE_UNAVAILABLE');
        const join = JSON.parse(pv.decodeMessage('parvane.group.v2.JoinResponse', resp)) as { pending?: boolean };
        if (join.pending) {
          client!.groupForget(hex);
          return { status: 'requested' as const };
        }
        await persist();
        deps.log(`v2: вступление в группу ${hex} по ссылке`);
        publishedGroups.add(groupAddress(hex));
        const info = toWireGroupInfo(hex, readGroup(hex)!);
        saveGroupCache(info, true);
        return { status: 'ok' as const, info };
      });
    } catch (e) {
      deps.log(`v2: вступление по ссылке не удалось: ${String(e)}`);
      return { status: 'error', code: inviteErrorCode(e) };
    }
  }

  // ── журнал личного состояния (T098): хост — stateJournal.ts ─────────────────

  const stateHost: StateJournalHost = {
    openSession: () => (ready ? client?.stateSession() : undefined),
    call: (method, body) => call('id', method, body),
    encode: (type, json) => pv!.encodeMessage(type, json),
    decode: (type, bytes) => pv!.decodeMessage(type, bytes),
    domain: () => serverDomain,
    log: deps.log,
  };

  // Устройства пользователя по журналу v2 (T059): то, чего нет в `v2`, —
  // устройство старой версии. `undefined` — журнала нет или движок не готов
  function logDevices(user: string): { v2: string[]; legacy: string[] } | undefined {
    if (!client || !ready) return undefined;
    const devices = JSON.parse(client.logDevices(user)) as { v2: string[]; legacy: string[] };
    return devices.v2.length ? devices : undefined;
  }

  // Пробуждение v2 (`push.wake.*`, T102): тот же VAPID, что у v1; журнал
  // v2 будит устройство только через свою регистрацию
  async function pushRegister(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    if (!pv || !ready) return false;
    const body = pv.encodeMessage('parvane.push.v1.RegisterRequest', JSON.stringify({
      registration: {
        kind: 'WAKE_KIND_WEB_PUSH',
        endpoint: subscription.endpoint,
        p256dh: fromBase64Url(subscription.keys.p256dh),
        auth: fromBase64Url(subscription.keys.auth),
      },
    }));
    await call('id', 'push.wake.register', body);
    return true;
  }

  // Приватность v2 (T079): сервер хранит её в identity и применяет к
  // доставке (жетоны незнакомцев) и добавлению в группы
  async function setPrivacy(settings: { groupAdd: 'anyone' | 'nobody'; strangers: boolean }) {
    if (!pv || !ready) return false;
    await call('id', 'identity.privacy.set', pv.encodeMessage('parvane.identity.v2.PrivacySetRequest', JSON.stringify({
      settings: {
        group_add: settings.groupAdd === 'nobody' ? 'AUDIENCE_NOBODY' : 'AUDIENCE_EVERYBODY',
        messages_from_strangers: settings.strangers,
      },
    })));
    return true;
  }

  async function pushUnregister(endpoint: string) {
    if (!pv || !ready) return false;
    await call('id', 'push.wake.unregister', pv.encodeMessage(
      'parvane.push.v1.UnregisterRequest', JSON.stringify({ endpoint }),
    ));
    return true;
  }

  /** Старое устройство: материал гранта линковки (только держатель SSK). */
  function linkGrantMaterial(): Uint8Array | undefined {
    if (!ready || !client) return undefined;
    try {
      return client.linkGrantMaterial();
    } catch (e) {
      deps.log(`v2: грант линковки недоступен: ${String(e)}`);
      return undefined;
    }
  }

  /** Новое устройство: вступить в журнал устройств по гранту и поднять стек. */
  async function joinWithGrant(material: Uint8Array): Promise<boolean> {
    // Грант мог прийти раньше, чем запуск выяснил «нужна линковка» — ждём исхода
    if (starting) await starting.catch(() => undefined);
    if (!needsLinking || ready) return false;
    linkMaterial = material;
    // Соединение прошлой попытки закрываем без автоповтора: запуск — ниже
    if (idConn) {
      idConn.onClose = undefined;
      idConn.close();
    }
    client?.free();
    client = undefined;
    starting = undefined;
    await start();
    return ready;
  }

  return {
    start,
    isReady: () => ready,
    needsLinking: () => needsLinking,
    linkGrantMaterial,
    joinWithGrant,
    cachedGroups,
    changeGroup,
    checkInvite,
    createGroup,
    createInvite,
    groupInfo,
    joinByInvite,
    listInvites,
    reportUnconfirmed: (address: string, claimed: string[]) => {
      if (client && isV2GroupAddress(address)) reportUnconfirmed(groupHex(address), claimed);
    },
    revokeInvite,
    isV2GroupAddress,
    isV2Chat,
    isV2InviteUrl: (url: string) => Boolean(parseV2Invite(url)) || V2_INVITE_REGEX.test(url.trim()),
    logDevices,
    pushRegister,
    pushUnregister,
    setPrivacy,
    // Режим «усиленная приватность» (L2): состояние чата и правило L2-1
    l2State: l2Gate.state,
    ephemeralAllowed: l2Gate.ephemeralAllowed,
    presenceAllowed: l2Gate.presenceAllowed,
    setDirectL2,
    setGroupL2,
    isV2Peer,
    trySend,
    tryEdit,
    tryDelete: (to: string, uuids: string[]) => tryMutation(to, {
      delete: { targets: uuids.map(ref), for_everyone: true },
    }),
    tryReact: (to: string, uuid: string, emoji: string) => tryMutation(to, {
      reaction: { target: ref(uuid), emoji, remove: !emoji },
    }),
    tryPin: (to: string, uuid: string, pin: boolean) => tryMutation(to, { pin: { target: ref(uuid), unpin: !pin } }),
    tryRead: (to: string, uuids: string[]) => tryMutation(to, {
      receipt: { kind: 'RECEIPT_KIND_READ', messages: uuids.map(ref) },
    }),
    reset() {
      ready = false;
      starting = undefined;
      needsLinking = false;
      linkMaterial?.fill(0);
      linkMaterial = undefined;
      idConn?.close();
      [...anonConns.keys()].forEach(closeAnon);
      anonPlanner?.free();
      anonPlanner = undefined;
      client?.free();
      client = undefined;
      peers.clear();
      messages.clear();
      reactions.clear();
      publishedGroups.clear();
      rotateTimers.forEach((timer) => clearTimeout(timer));
      rotateTimers.clear();
      warnedUnconfirmed.clear();
    },
  };
}

// Ссылка-приглашение v2: `https://<домен>/join/<link_id>#<секрет>` (base64url, 32 байта)
const V2_INVITE_REGEX = /^https:\/\/[^/\s]+\/join\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/;

export function isV2GroupAddress(address: string) {
  return address.startsWith(V2_GROUP_PREFIX);
}

function groupHex(address: string) {
  return address.slice(V2_GROUP_PREFIX.length);
}

function groupAddress(hex: string) {
  return `${V2_GROUP_PREFIX}${hex}`;
}

function isRateLimited(e: unknown) {
  return /RateLimited|RATE_LIMITED/.test(e instanceof V2Error ? e.code : String(e));
}

function pause(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function b64ToHex(value: string) {
  return Array.from(atob(value), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function hexToB64(hex: string) {
  return btoa(String.fromCharCode(...(hex.match(/../g) || []).map((h) => parseInt(h, 16))));
}

/** UUIDv7 (id служебных сообщений v2: мутации, квитанции). */
export function newV7(): string {
  const ms = BigInt(Date.now());
  const b = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// base64url (PushSubscription.toJSON) → base64 для proto3-JSON
function fromBase64Url(value: string) {
  const std = value.replace(/-/g, '+').replace(/_/g, '/');
  return std + '='.repeat((4 - (std.length % 4)) % 4);
}
