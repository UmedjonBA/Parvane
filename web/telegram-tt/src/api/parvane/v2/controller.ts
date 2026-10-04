// Протокол v2 в web (spec 007, E2: T055/T056). Двухстековый клиент на
// переходный период: v1-стек провайдера (libolm) обслуживает v1-собеседников,
// этот контроллер — собеседников с журналом устройств v2 (WASM-движок,
// отдельный Olm-аккаунт устройства). Формат выбирается по подписанному
// журналу собеседника (D-13), не по флагам сервера.
//
// Входящие записи журнала инбокса открывает движок; содержимое перекладывается
// в WireStoredMessage и идёт в ТОТ ЖЕ конвейер отображения, что и v1
// (sync.applyExternal) — UI не знает, по какому протоколу пришло сообщение.

import type { WireCallSignal } from '../callengine';
import type { WireGroupInvite } from '../groupcall';
import type {
  WireAdminRights, WireDefaultPermissions, WireGroupInfo, WireMessageContent, WireStoredMessage,
} from '../wire';
import type { V2Content } from './contentMap';
import type { Protocol, PvClient } from './engine';
import type { StateJournalHost } from './stateJournal';

import { SecureE2eStorage } from '../secureStorage';
import {
  callSignalFromV2, callSignalToV2, groupCallIdFromV2, groupInviteFromV2, type V2CallSignal,
} from './callMap';
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
  /** Кадр инбокса v1, переложенный сервером в инбокс v2 (запись `LegacyV1`:
   * история v1 при первом синке и живые кадры) — FR-053. */
  onLegacyFrame?: (frame: string) => void;
  /** Ключ восстановления нового корня — показать пользователю один раз. */
  onRecoveryKey: (recoveryKey: string) => void;
  /** Включён ли v2-стек (флаг): липкость D-13 действует только при нём. */
  isEnabled: () => boolean;
  /** Сервер ответил UPGRADE_REQUIRED: версия клиента ниже min_supported. */
  onUpgradeRequired: () => void;
  /** JWT не принят на соединении v2 — нужен повторный вход. */
  onAuthRejected?: () => void;
  /** Группа v2 появилась/изменилась (сведения — из проверенного журнала). */
  onGroupUpdated: (info: WireGroupInfo, isNew: boolean) => void;
  /** Нас исключили/забанили или группа удалена. */
  onGroupLeft: (address: string) => void;
  /** FR-028 (T080): участники без подтверждённой записи администратора. */
  onUnconfirmedMembers: (address: string, members: string[]) => void;
  /** Стек поднят: журнал личного состояния (T098) можно читать. */
  onStateReady?: (host: StateJournalHost, rekey?: 'self' | 'peer') => void;
  /** Ссылка-приглашение создана/отозвана здесь — остальным своим устройствам (T160). */
  onInviteCreated?: (address: string, record: V2InviteRecord) => void;
  onInviteRevoked?: (linkId: string) => void;
  /** Свои устройства по каталогу v1 (id и ключи) — для подписанного списка
   * v1-устройств, которым v2-клиенты шлют легаси-копии (FR-058). */
  listOwnV1Devices?: () => Promise<{ deviceId: string; identity: string; signing: string }[]>;
  /** У собеседника сменился корень личности (KEY-1 v2, T129): служебное
   * сообщение «ключ безопасности изменился» в чате с ним. */
  onPeerRootChanged?: (user: string) => void;
  /** Отозвано устройство, державшее SSK (T128, D-12): до смены SSK корнем
   * (ключ восстановления) новые устройства в журнал не принимаются. */
  onSskRotationNeeded?: () => void;
  /** «Печатает» по эфемерному каналу v2 (T127): `chat` — адрес собеседника
   * либо группы v2, `from` — кто печатает. */
  onTyping?: (chat: string, from: string) => void;
  /** «В сети» по эфемерному каналу v2 (T134): автора проверил движок. */
  onPresence?: (from: string) => void;
  /** Сигнал личного звонка от v2-собеседника: отправитель и привязка к звонку уже
   * проверены движком (сертификат устройства, подпись, аудитория, цель). */
  // `groupCallId` — попарный сигнал внутри группового звонка (T141)
  onCallSignal?: (from: string, signal: WireCallSignal | WireGroupInvite, groupCallId?: string) => void;
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
  migratedFrom?: string;
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

/** Устройство v2 в ручной копии ключей (перенос устройства на другой браузер). */
export type V2DeviceBackup = {
  key: string;
  state: string;
  rootBackup?: string;
  invites?: Record<string, V2InviteRecord[]>;
};

/** Заявка на вступление в группу v2 (ссылка с одобрением). */
export type V2JoinRequest = { user: string; date: number };

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

/** Ссылка вместе с группой — вид, которым ссылки делятся между своими устройствами (T160). */
export type V2SharedInvite = { address: string; record: V2InviteRecord };

export type V2InviteCheck = {
  address: string;
  about?: string;
  avatar?: string;
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
// Итог отзыва устройства (движок: `revokeDevice`)
type RevokeOutcome = {
  requests: OutReq[];
  pendingKeyShares: string[];
  pendingEpochs: string[];
  epochsNeedAdmin: string[];
  sskRotationRequired: boolean;
  stateKeyVersion?: number;
};
export type SskRotationResult = 'ok' | 'bad_key' | 'no_backup' | 'failed';
// Скачивание/загрузка блобов (чанки до 700 КиБ)
const BLOB_TIMEOUT_MS = 60000;
// parvane.msg.v2.TypingAction
const TYPING_ACTION_TYPING = 1;
const TYPING_ACTION_CANCEL = 2;
type LogDevices = {
  v2: string[];
  legacy: string[];
  legacySet: boolean;
  legacyKeys: { deviceId: string; identity: string; signing: string }[];
  // Корневой ключ личности (base64 без дополнения) — из него «ключ безопасности»
  root?: string;
};

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
  signal?: V2CallSignal;
};

const STATE_RECORD = 'v2-engine';
const GROUP_RESYNC_MS = 3000;
const INVITES_RECORD = 'v2-invites';
const V2_GROUP_PREFIX = 'v2g:';
const GROUP_KIND_GROUP = 1;
const GROUP_KIND_CHANNEL = 2;
const ROLE_NAMES: Record<number, string> = { 1: 'member', 2: 'admin', 3: 'owner' };
// Движок отдаёт права в proto3-JSON: `false` опущен. На проводе v1 пропуск
// означает «по умолчанию» (разрешено), поэтому набор раскрывается явно —
// иначе запрет в группе v2 читался бы как разрешение
const PERMISSION_FIELDS = [
  'send_messages', 'send_media', 'send_stickers_gifs', 'send_polls',
  'embed_links', 'invite_users', 'pin_messages', 'change_info',
] as const;
const ADMIN_RIGHT_FIELDS = [
  'change_info', 'delete_messages', 'ban_users', 'invite_users', 'pin_messages', 'add_admins',
] as const;

function expandFlags<K extends string>(fields: readonly K[], value?: Partial<Record<K, boolean>>) {
  const out = {} as Record<K, boolean>;
  for (const field of fields) out[field] = Boolean(value?.[field]);
  return out;
}
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
// FR-063: срок партии жетонов задаёт движок; здесь — шаг проверки расписания
const TOKEN_CHECK_MS = 60 * 60 * 1000;
// Партия меньше суточной квоты: квота на аккаунт, её делят все его устройства
const TOKEN_BATCH = 20;
// Квота — на аккаунт и сутки: если партия целиком в остаток не влезает (его
// выбрали другие устройства аккаунта), сервер отвечает LIMIT на весь запрос —
// просим остаток партией поменьше, иначе устройство останется без жетонов
const TOKEN_BATCH_STEPS = [TOKEN_BATCH, 10, 5, 2, 1];
const GROUP_SYNC_PAGES = 50;
const OWN_DEVICES_RECORD = 'v2-own-devices';
const ROOT_BACKUP_RECORD = 'v2-root-backup';
// Какая копия корня уже лежит на сервере (чтобы не слать при каждом запуске)
const ROOT_BACKUP_SENT_RECORD = 'v2-root-backup-sent';
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
  // Копия корня под ключом восстановления (не секрет без ключа): едет в гранте
  // линковки, чтобы любое своё устройство могло сменить SSK
  let rootBackupB64: string | undefined;
  let linkMaterial: Uint8Array | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const peers = new Map<string, { v2: boolean; at: number }>();
  // Чаты, на эфемерные каналы которых подписываемся (переживает переподключение)
  const ephChats = new Set<string>();
  const messages = new Map<string, WireStoredMessage>();
  const reactions = new Map<string, Map<string, string>>();
  // Домен сервера из описателя (группы v2 живут на нём)
  let serverDomain = '';
  // Группы, уже показанные UI (новая — с updateChatJoin)
  // Устройство подменено копией ключей — ждём входа под его device_id (importBackup)
  let isHalted = false;
  const publishedGroups = new Set<string>();
  // Число заявок на вступление по группам (hex) — для админа с правом приглашать
  const pendingRequests = new Map<string, number>();
  const rotateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let tokenTimer: ReturnType<typeof setInterval> | undefined;
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
        const syncFrom = (after: string) => call('anon', 'identity.device.log_sync_anon', pv!.encodeMessage(
          'parvane.identity.v2.DeviceLogSyncAnonRequest',
          JSON.stringify({ user: { address: user }, after_version: after }),
        ));
        const before = String(client.logVersion(user));
        let verdict = client.ingestLog(user, await syncFrom(before));
        // Журнал на сервере начат заново (другой генезис) — перечитать целиком
        if (verdict === 'replaced') verdict = client.ingestLog(user, await syncFrom('0'));
        if (verdict === 'rootChanged') return acceptPeerRoot(user);
        // Журнал не продвинулся, а движок просит его снова: собеседник прямо сейчас
        // публикует первое устройство (корень записан, сертификат ещё нет) — дать
        // ему дописать, а не сжечь все попытки за миллисекунды
        if (verdict !== 'replaced' && before !== '0' && String(client?.logVersion(user)) === before) {
          await new Promise((resolve) => {
            setTimeout(resolve, 400);
          });
        }
        return verdict !== 'replaced';
      }
      case 'rootChanged':
        return acceptPeerRoot(need.user!);
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
        await requestTokens(TOKEN_BATCH);
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

  // KEY-1 v2 (T129, FR-019): у собеседника сменился корень личности (он начал
  // журнал устройств заново). Как в v1: предупреждение «ключ безопасности
  // изменился» в чате, новый журнал принимается, прежние сессии отбрасываются
  async function acceptPeerRoot(user: string): Promise<boolean> {
    if (!client?.acceptRootChange(user)) return false;
    peers.delete(user);
    await persist();
    deps.log(`v2: у ${user} сменился корневой ключ — предупреждение показано, новый журнал принят`);
    deps.onPeerRootChanged?.(user);
    return true;
  }

  // ── запуск ────────────────────────────────────────────────────────────────

  async function start() {
    if (starting) return starting;
    starting = (async () => {
      const self = deps.getSelf();
      const token = deps.getToken();
      if (!self || !token || isHalted) return;
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
        if (ev.eventKind === 'ephemeral') applyEphemeral(ev.body);
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
        // Пока устройство было выключено, личность аккаунта могли сбросить
        // (новый корень и журнал, T130): тогда оно вне неё — только линковка
        const ownLog = await call('id', 'identity.device.log_sync', pv.encodeMessage(
          'parvane.identity.v2.DeviceLogSyncRequest',
          JSON.stringify({ user: { address: self }, after_version: String(client.logVersion(self)) }),
        )).catch(() => undefined);
        if (ownLog && client.ingestLog(self, ownLog) === 'replaced') {
          await dropIdentity();
          return;
        }
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
            // Копия корня под ключом восстановления (поле `rb`): с ней и это
            // устройство сможет сменить SSK после отзыва другого (D-12)
            const rootBackup = pv.grantRootBackup(material);
            if (rootBackup) {
              rootBackupB64 = b64(rootBackup);
              await storage.saveRecord(ROOT_BACKUP_RECORD, rootBackupB64);
            }
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
          rootBackupB64 = b64(backup);
          await storage.saveRecord(ROOT_BACKUP_RECORD, rootBackupB64);
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
      rootBackupB64 = rootBackupB64 || await storage.loadRecord<string>(ROOT_BACKUP_RECORD);
      await call('id', 'msg.inbox.subscribe', new Uint8Array());
      ready = true;
      void serial(refillTokens);
      tokenTimer = tokenTimer || setInterval(() => void serial(refillTokens), TOKEN_CHECK_MS);
      // Группы v2 из состояния движка — в UI до разбора инбокса
      client.groupList().forEach((hex) => publishGroup(hex));
      await serial(syncAll);
      // L2-1: до готовности движка решение о typing/presence бралось из памяти
      l2Gate.reconcile([...loadStickyPeers(), ...publishedGroups])
        .forEach((address) => deps.onL2Changed?.(address));
      deps.log('v2: готов');
      // «Печатает» по v2: каналы известных v2-собеседников и групп
      void ensureEphemeral([...loadStickyPeers(), ...publishedGroups, ...ephChats]);
      deps.onStateReady?.(stateHost);
      void refreshOwnDevices().catch((e: unknown) => deps.log(`v2: журнал своих устройств: ${String(e)}`));
      void uploadRootBackup().catch((e: unknown) => deps.log(`v2: копия корня на сервер не ушла: ${String(e)}`));
    })().catch((e: unknown) => {
      starting = undefined;
      deps.log(`v2: запуск не удался: ${String(e)}`);
      // Сервер больше не принимает эту версию протокола (Welcome не пришёл)
      if (e instanceof V2Error && e.code === 'ERROR_CODE_UPGRADE_REQUIRED') deps.onUpgradeRequired();
      // Сервер не принял JWT (истёк, отозван). Без соединения v1 отказ виден только
      // здесь (E6-1): повторять тем же токеном бессмысленно — нужен повторный вход
      if (e instanceof V2Error && e.code === 'ERROR_CODE_REVOKED') deps.onAuthRejected?.();
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
      try {
        await applyEvent(ev);
      } catch (e) {
        // Сбой одного события (например, журнал группы не дочитался) не должен
        // молча терять остальные и само событие: пишем причину; журнал группы
        // дочитается повтором
        deps.log(`v2: событие ${ev.type} не применено: ${String(e)}`);
        if (ev.type !== 'groupChanged' || !ev.group) continue;
        // Журнал больше не отдают (нас исключили/забанили, группа удалена) —
        // сервер дальше не пустит: группа снимается у клиента, как в desktop
        if (isForbidden(e) || /NOT_FOUND/.test(String(e))) dropGroup(ev.group.id);
        else scheduleGroupResync(ev.group.id);
      }
    }
    const err = client.lastError();
    if (err) deps.log(`v2: ошибка записи: ${err}`);
    await persist();
  }

  function dropGroup(hex: string) {
    const g = readGroup(hex);
    const address = groupAddress(hex);
    client?.groupForget(hex);
    if (g) saveGroupCache(toWireGroupInfo(hex, g), false);
    l2Gate.forget(address);
    if (publishedGroups.delete(address)) deps.onGroupLeft(address);
  }

  // Журнал группы не дочитался по уведомлению — повтор с нуля (локальная копия
  // могла разойтись с серверной), не чаще раза в GROUP_RESYNC_MS на группу
  const groupResyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleGroupResync(hex: string) {
    if (groupResyncTimers.has(hex)) return;
    groupResyncTimers.set(hex, setTimeout(() => {
      groupResyncTimers.delete(hex);
      void serial(async () => {
        if (!client || !ready) return;
        client.groupForget(hex);
        await syncGroup(hex);
        await persist();
        deps.log(`v2: журнал группы ${hex} перечитан заново`);
      }).catch((e: unknown) => deps.log(`v2: журнал группы ${hex} не перечитан: ${String(e)}`));
    }, GROUP_RESYNC_MS));
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
    if (ev.type === 'legacyV1') {
      if (ev.json) deps.onLegacyFrame?.(ev.json);
      return;
    }
    if (ev.type === 'call') {
      if (!ev.from || !ev.signal) return;
      const invite = groupInviteFromV2(ev.signal);
      if (invite) {
        deps.onCallSignal?.(ev.from, invite);
        return;
      }
      const signal = callSignalFromV2(ev.signal);
      if (signal) deps.onCallSignal?.(ev.from, signal, groupCallIdFromV2(ev.signal));
      return;
    }
    if (ev.type === 'groupChanged' && ev.group) {
      await syncGroup(ev.group.id);
      // Уведомление без смены версии — заявка на вступление появилась или снята
      const hex = ev.group.id;
      if (canDecideRequests(hex) && readGroup(hex)?.inviteLinks.length) {
        void listJoinRequests(groupAddress(hex));
      } else if (pendingRequests.get(hex)) {
        notePendingRequests(hex, 0);
      }
      return;
    }
    const isGroup = ev.type === 'group' && Boolean(ev.group);
    if ((ev.type === 'direct' || isGroup) && ev.content && ev.opId && ev.from) {
      const self = deps.getSelf();
      const chat = ev.chat || ev.from;
      const c = ev.content;
      const author = ev.from;
      // Собеседник написал по v2 — он «липкий» (D-13): наши ответы и мутации его
      // сообщений идут только по v2, даже если стек в этот момент переподнимается
      if (!isGroup && author !== self) rememberStickyPeer(author);
      // Группа: сообщение кладётся в чат группы, автор — из проверенной подписи
      const to = isGroup ? groupAddress(ev.group!.id) : (author === self ? chat : self);
      // Ключ доставки собеседника мог прийти только что — канал «печатает» чата
      void ensureEphemeral([isGroup ? to : chat]);
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
    if (ev.type === 'deviceAdded') {
      await checkOwnDevices();
      await syncLegacySet();
    }
    // Отозвано своё устройство (другим своим устройством): журнал — заново;
    // ротации ключей делает отзывавшее устройство и раздаёт по E2E
    if (ev.type === 'deviceRevoked') {
      await checkOwnDevices();
      if (client?.ownSskExposed()) deps.onSskRotationNeeded?.();
    }
    // Своё устройство передало (новый) ключ личного состояния — журнал заново
    if (ev.type === 'stateKeyRotated') deps.onStateReady?.(stateHost, 'peer');
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
    if (client.ingestLog(self, resp) === 'replaced') {
      // Личность аккаунта сброшена другим устройством (новый корень, новый
      // журнал): это устройство в неё не входит — только линковка заново
      await dropIdentity();
      return;
    }
    const current = (JSON.parse(client.logDevices(self)) as { v2: string[] }).v2;
    const known = await storage.loadRecord<string[]>(OWN_DEVICES_RECORD);
    await storage.saveRecord(OWN_DEVICES_RECORD, current);
    await persist();
    // Первая проверка на этом устройстве — запоминаем, не уведомляем
    if (!known) return;
    const added = current.filter((id) => !known.includes(id) && id !== ownDeviceId);
    if (!added.length) return;
    deps.onNewOwnDevices(added);
    await shareGroupsWithOwnDevices(added);
  }

  // T142: грант линковки несёт только ключи устройства — группы v2 новому
  // своему устройству пересылает то, что в них уже состоит (ключи текущей
  // эпохи и входящие сессии Megolm участников)
  async function shareGroupsWithOwnDevices(devices: string[]) {
    if (!client) return;
    try {
      const reqs = await withNeeds(() => client!.shareGroupsWithOwnDevices(JSON.stringify(devices)) as OutReq[]);
      await run(reqs);
      await persist();
      if (reqs.length) deps.log(`v2: группы пересланы новому своему устройству (записей ${reqs.length})`);
    } catch (e) {
      deps.log(`v2: группы новому своему устройству не пересланы: ${String(e)}`);
    }
  }

  /** v1-копии сообщения для v1-устройств из подписанных списков (FR-054):
   * готовый v1 SendPayload уходит методом `msg.deliver_legacy`. */
  async function deliverLegacy(uuid: string, sendPayloadJson: string) {
    if (!client || !ready) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const req = client.legacyDeliverRequest(uuid, sendPayloadJson) as OutReq;
    await call(req.chan, req.method, req.body);
  }

  // ── Новое устройство без других устройств (T130, FR-066) ───────────────────

  async function dropIdentity() {
    deps.log('v2: личность аккаунта сброшена другим устройством — нужна линковка этого устройства');
    ready = false;
    await storage?.deleteRecord(STATE_RECORD).catch(() => undefined);
    await storage?.deleteRecord(ROOT_BACKUP_RECORD).catch(() => undefined);
    rootBackupB64 = undefined;
    client?.free();
    client = undefined;
    needsLinking = true;
    deps.onNeedsLinking?.();
  }

  /** Перезапуск стека из сохранённого состояния (как после гранта линковки). */
  async function restart() {
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

  // ── ручная копия ключей (перенос устройства, как у v1) ─────────────────────
  // Сообщения v2 запечатаны под устройства журнала: чтобы другой браузер читал
  // новые сообщения после импорта копии, он должен стать ЭТИМ устройством —
  // копия несёт состояние движка (ключи устройства, сессии, группы) под паролем
  // копии. Истории v2 в состоянии движка нет — она едет строками (`v2History`).

  async function exportBackup(): Promise<V2DeviceBackup | undefined> {
    if (!ready || !client || !storage || !storageKey) return undefined;
    await persist();
    const state = await storage.loadRecord<string>(STATE_RECORD);
    if (!state) return undefined;
    return {
      key: b64(storageKey),
      state,
      rootBackup: await storage.loadRecord<string>(ROOT_BACKUP_RECORD),
      invites: await loadInvites(),
    };
  }

  /** Положить устройство v2 из копии ключей. Стек до следующего входа не
   * поднимается: текущий JWT выпущен под прежний device_id этого браузера. */
  async function importBackup(backup: V2DeviceBackup) {
    const self = deps.getSelf();
    if (!self || typeof backup?.key !== 'string' || typeof backup.state !== 'string') return false;
    isHalted = true;
    const target = storage || await SecureE2eStorage.open(self);
    await target.saveRecord(KEY_RECORD, backup.key);
    await target.saveRecord(STATE_RECORD, backup.state);
    if (backup.rootBackup) await target.saveRecord(ROOT_BACKUP_RECORD, backup.rootBackup);
    if (backup.invites) await target.saveRecord(INVITES_RECORD, backup.invites);
    deps.log('v2: устройство восстановлено из копии ключей');
    return true;
  }

  /** Копия корня под ключом восстановления — на сервер (FR-066): по ней новое
   * устройство восстановит корень, когда других устройств не осталось. */
  async function uploadRootBackup() {
    if (!pv || !rootBackupB64 || !storage) return;
    if (await storage.loadRecord<string>(ROOT_BACKUP_SENT_RECORD) === rootBackupB64) return;
    await call('id', 'identity.root.backup_set', pv.encodeMessage(
      'parvane.identity.v2.RootBackupSetRequest', JSON.stringify({ backup: rootBackupB64 }),
    ));
    await storage.saveRecord(ROOT_BACKUP_SENT_RECORD, rootBackupB64);
  }

  /** Восстановление по ключу восстановления: корень — из копии на сервере,
   * новый SSK, прежние устройства отзываются, это устройство входит в журнал. */
  async function recoverWithKey(recoveryKey: string): Promise<SskRotationResult> {
    if (starting) await starting.catch(() => undefined);
    if (!pv || !storage || !storageKey || !needsLinking || ready || !ownDeviceId) return 'failed';
    const self = deps.getSelf();
    let backup: Uint8Array;
    try {
      const got = JSON.parse(pv.decodeMessage(
        'parvane.identity.v2.RootBackupGetResponse',
        await call('id', 'identity.root.backup_get', new Uint8Array()),
      )) as { backup?: string };
      if (!got.backup) return 'no_backup';
      backup = unb64(got.backup);
    } catch (e) {
      deps.log(`v2: копия корня не получена: ${String(e)}`);
      return 'failed';
    }
    const fresh = new pv.PvClient(self, ownDeviceId, serverDomain);
    try {
      fresh.importRootBackupFor(backup, recoveryKey.trim());
    } catch {
      fresh.free();
      return 'bad_key';
    }
    try {
      const ownLog = await call('id', 'identity.device.log_sync', pv.encodeMessage(
        'parvane.identity.v2.DeviceLogSyncRequest',
        JSON.stringify({ user: { address: self }, after_version: '0' }),
      ));
      await run(fresh.recoverWithRoot(ownLog, OTK_COUNT) as OutReq[]);
      fresh.forgetRoot();
      await storage.saveRecord(STATE_RECORD, b64(fresh.export(storageKey)));
      rootBackupB64 = b64(backup);
      await storage.saveRecord(ROOT_BACKUP_RECORD, rootBackupB64);
      needsLinking = false;
      deps.log('v2: устройство восстановлено ключом восстановления (прежние устройства отозваны)');
    } catch (e) {
      deps.log(`v2: восстановление по ключу не удалось: ${String(e)}`);
      return 'failed';
    } finally {
      fresh.free();
    }
    return (await restart()) ? 'ok' : 'failed';
  }

  /** Сброс личности: новый корень и журнал взамен прежних (ключа восстановления
   * нет). Собеседники увидят смену ключа безопасности; прежняя переписка v2
   * этим устройством не читается. Нужен пароль (переаутентификация). */
  async function resetIdentity(password: string): Promise<'ok' | 'bad_password' | 'failed'> {
    if (starting) await starting.catch(() => undefined);
    if (!pv || !storage || !storageKey || !needsLinking || ready || !ownDeviceId) return 'failed';
    try {
      await call('id', 'identity.session.reauth', pv.encodeMessage(
        'parvane.identity.v2.SessionReauthRequest', JSON.stringify({ password }),
      ));
    } catch {
      return 'bad_password';
    }
    const fresh = new pv.PvClient(deps.getSelf(), ownDeviceId, serverDomain);
    let recoveryKey: string;
    try {
      const created = fresh.resetIdentity(OTK_COUNT) as { requests: OutReq[]; rootSecret: Uint8Array };
      await run(created.requests);
      recoveryKey = pv.generateRecoveryKey();
      rootBackupB64 = b64(fresh.exportRootBackup(recoveryKey, created.rootSecret));
      fresh.forgetRoot();
      created.rootSecret.fill(0);
      await storage.saveRecord(ROOT_BACKUP_RECORD, rootBackupB64);
      await storage.saveRecord(STATE_RECORD, b64(fresh.export(storageKey)));
      needsLinking = false;
      deps.log('v2: личность сброшена — новый корень и журнал устройств');
    } catch (e) {
      deps.log(`v2: сброс личности не удался: ${String(e)}`);
      return 'failed';
    } finally {
      fresh.free();
    }
    if (!(await restart())) return 'failed';
    deps.onRecoveryKey(recoveryKey);
    return 'ok';
  }

  // ── Отзыв своего устройства (T128, FR-066; D-11, D-12, D-16) ───────────────

  /** Отозвать своё v2-устройство: запись в журнале устройств, затем ротации —
   * ключ доступа к доставке (сервер + свои устройства + собеседники), ключ
   * личного состояния, новые эпохи групп, где мы админ. false — устройство не
   * в журнале v2 (только v1-отзыв). Бросает, если запись журнала не принята. */
  async function revokeDevice(deviceId: string): Promise<boolean> {
    if (!client || !ready) return false;
    if (!logDevices(deps.getSelf())?.v2.includes(deviceId) || deviceId === ownDeviceId) return false;
    await serial(async () => {
      const outcome = await withNeeds(() => client!.revokeDevice(deviceId) as RevokeOutcome);
      const [entry, ...rotations] = outcome.requests;
      try {
        await call(entry.chan, entry.method, entry.body);
      } catch (e) {
        // Сервер запись не принял, а движок её уже применил — поднять состояние
        // заново из сохранённого (переподключение читает его с диска)
        idConn?.close();
        throw e;
      }
      for (const r of rotations) {
        await call(r.chan, r.method, r.body)
          .catch((e: unknown) => deps.log(`v2: ротация после отзыва (${r.method}): ${String(e)}`));
      }
      await persist();
      // Отложенное: собеседники, которым новый ключ доступа не ушёл, и группы,
      // где эпоху сменить не удалось (добор данных/частота)
      for (const peer of outcome.pendingKeyShares) {
        try {
          await run(await withNeeds(() => client!.shareDeliveryKey(peer) as OutReq[]));
        } catch (e) {
          deps.log(`v2: ключ доступа ${peer} не роздан: ${String(e)}`);
        }
      }
      for (const hex of outcome.pendingEpochs) {
        await rotateEpoch(hex).then(() => publishGroup(hex))
          .catch((e: unknown) => deps.log(`v2: новая эпоха группы ${hex} после отзыва: ${String(e)}`));
      }
      await persist();
      deps.log(`v2: устройство отозвано (ротаций ${rotations.length}, эпох ждут админа ${
        outcome.epochsNeedAdmin.length})`);
      // Ключ личного состояния сменён — журнал состояния заново под новым ключом
      if (outcome.stateKeyVersion !== undefined) deps.onStateReady?.(stateHost, 'self');
    });
    if (client?.ownSskExposed()) deps.onSskRotationNeeded?.();
    return true;
  }

  /**
   * Отзыв доступа у одного собеседника (FR-033) — при блокировке: сама она ключ
   * доступа к доставке не отнимает. Новый ключ — серверу, своим устройствам и
   * остальным собеседникам. false — ключа у собеседника не было.
   */
  async function revokeContactAccess(peer: string): Promise<boolean> {
    if (!client || !ready || !peer || peer === deps.getSelf()) return false;
    return serial(async () => {
      const outcome = await withNeeds(() => client!.revokeContactAccess(peer) as {
        requests: OutReq[]; pendingKeyShares: string[];
      });
      const [keySet, ...shares] = outcome.requests;
      if (!keySet) return false;
      try {
        await call(keySet.chan, keySet.method, keySet.body);
      } catch (e) {
        // Сервер новый ключ не принял, а движок уже сменил — поднять состояние
        // заново из сохранённого
        idConn?.close();
        throw e;
      }
      for (const r of shares) {
        await call(r.chan, r.method, r.body)
          .catch((e: unknown) => deps.log(`v2: раздача ключа доступа (${r.method}): ${String(e)}`));
      }
      await persist();
      for (const other of outcome.pendingKeyShares) {
        try {
          await run(await withNeeds(() => client!.shareDeliveryKey(other) as OutReq[]));
        } catch (e) {
          deps.log(`v2: ключ доступа ${other} не роздан: ${String(e)}`);
        }
      }
      await persist();
      deps.log(`v2: доступ собеседника отозван — ключ доступа сменён (раздач ${shares.length})`);
      return true;
    });
  }

  /** SSK раскрыт отзывом устройства и ещё не сменён; есть ли копия корня. */
  function sskState() {
    return {
      isRotationNeeded: Boolean(ready && client?.ownSskExposed()),
      hasBackup: Boolean(rootBackupB64),
    };
  }

  /** Сменить SSK корнем (D-12): корень — из копии под ключом восстановления,
   * в памяти только на время операции. */
  async function rotateSsk(recoveryKey: string): Promise<SskRotationResult> {
    if (!client || !ready) return 'failed';
    if (!rootBackupB64) return 'no_backup';
    try {
      client.importRootBackup(unb64(rootBackupB64), recoveryKey.trim()).fill(0);
    } catch {
      return 'bad_key';
    }
    try {
      await serial(async () => {
        const reqs = client!.rotateSsk() as OutReq[];
        try {
          await run(reqs);
        } catch (e) {
          idConn?.close();
          throw e;
        }
        await persist();
      });
      deps.log('v2: SSK сменён корнем');
      await serial(syncLegacySet);
      return 'ok';
    } catch (e) {
      deps.log(`v2: смена SSK не удалась: ${String(e)}`);
      return 'failed';
    } finally {
      client?.forgetRoot();
    }
  }

  /** Журнал своих устройств и список v1-устройств — после запуска и по событию. */
  async function refreshOwnDevices() {
    await checkOwnDevices();
    await serial(syncLegacySet);
  }

  // ── маршрутизация ─────────────────────────────────────────────────────────

  /** Собеседник на v2? (есть журнал устройств; кэш 10 мин). */
  async function isV2Peer(address: string): Promise<boolean> {
    if (address === deps.getSelf() || isV2GroupAddress(address)) return false;
    // D-13 (C2-02): собеседник, однажды замеченный на v2, по v1 больше не
    // получает — иначе сервер, оборвав v2-соединение, увидел бы отправителя.
    // v2 недоступен → ошибка отправки, а не тихий откат
    const isSticky = deps.isEnabled() && loadStickyPeers().has(address);
    // Стек ещё поднимается (сразу после входа) либо переподключается после
    // обрыва — дождаться, а не отказать: мутация, ушедшая по v1, пропала бы
    // (сервер v1 сообщений v2 не знает)
    if (isSticky && !ready) await (starting || start()).catch(() => undefined);
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
        await runDirect(to, () => client!.prepareDirect(to, JSON.stringify(content), uuid) as OutReq[]);
      }
      await persist();
    });
  }

  /** Запросы личного чата. Сервер отверг ключ доступа собеседника (FORBIDDEN:
   * он сменил ключ — отзыв устройства, восстановление, сброс личности) —
   * повтор со слепым жетоном; новый ключ придёт с его следующим сообщением. */
  async function runDirect(to: string, prepare: () => OutReq[]) {
    try {
      await run(await withNeeds(prepare));
    } catch (e) {
      if (!isForbidden(e) || !client?.deliveryKeyRejected(to)) throw e;
      deps.log('v2: ключ доступа собеседника отвергнут — повтор со слепым жетоном');
      await run(await withNeeds(prepare));
    }
  }

  /** Чат идёт по v2: группа v2 или собеседник с журналом устройств v2. */
  async function isV2Chat(address: string) {
    if (isV2GroupAddress(address)) {
      if (!ready && starting) await starting.catch(() => undefined);
      if (!ready || !client) throw new V2Error('ERROR_CODE_UNAVAILABLE');
      return true;
    }
    // «Избранное» (чат с собой, T147): копии — своим устройствам журнала v2;
    // по v1 оно не дошло бы до привязанных устройств вне каталога v1
    if (address === deps.getSelf()) {
      if (!ready && starting) await starting.catch(() => undefined);
      return ready && Boolean(client);
    }
    return isV2Peer(address);
  }

  /** Сигнал личного звонка v2-собеседнику (D-08): запечатанным конвертом по
   * анонимному каналу, сервер не видит ни сторон, ни SDP. false — не v2 (идти по v1). */
  async function trySendCall(
    to: string, signal: WireCallSignal | WireGroupInvite, groupCallId?: string,
  ): Promise<boolean> {
    if (isV2GroupAddress(to) || !(await isV2Peer(to))) return false;
    // Групповой звонок (T141): попарные сигналы идут запечатанными конвертами
    // только тем участникам, чей ключ доступа известен (сервер не принимает для
    // звонков слепые жетоны); остальным — прежним путём. Личный звонок по v1 не
    // понижается (D-13)
    const isGroup = signal.type === 'group_invite' || groupCallId !== undefined;
    if (isGroup && !client?.hasPeerDeliveryKey(to)) return false;
    const v2Signal = callSignalToV2(signal, groupCallId);
    // Собеседник на v2, а сигнал по v2 не выразить — по v1 не понижаем (D-13)
    if (!v2Signal) throw new V2Error('ERROR_CODE_INVALID');
    await serial(async () => {
      await runDirect(to, () => client!.prepareCall(to, JSON.stringify(v2Signal)) as OutReq[]);
      await persist();
    });
    return true;
  }

  // ── Блобы вложений по capability (T131, FR-062, D-08) ──────────────────────
  // Блоб сообщения v2-чата загружается без per-recipient гранта: сервер хранит
  // SHA-256 секрета, сам секрет едет внутри E2E-содержимого. Получатель качает
  // блоб анонимным каналом — записи «отправитель → получатель» в cloud нет

  /** Загрузить шифртекст блоба; возвращает file_id. */
  async function uploadBlob(bytes: Uint8Array, capability: Uint8Array, chunkBytes: number): Promise<string> {
    if (!pv || !ready) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', capability as BufferSource));
    const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
    let uploadId = '';
    for (let index = 0; index < total; index++) {
      const data = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes);
      const resp = await call('id', 'cloud.blob.upload_chunk', pv.encodeMessage(
        'parvane.cloud.v1.UploadChunkRequest', JSON.stringify({ upload_id: uploadId, index, data: b64(data) }),
      ));
      const got = JSON.parse(pv.decodeMessage('parvane.cloud.v1.UploadChunkResponse', resp)) as {
        uploadId?: string; upload_id?: string;
      };
      uploadId = got.uploadId || got.upload_id || uploadId;
    }
    const done = JSON.parse(pv.decodeMessage('parvane.cloud.v1.UploadCompleteResponse', await call(
      'id', 'cloud.blob.upload_complete', pv.encodeMessage('parvane.cloud.v1.UploadCompleteRequest', JSON.stringify({
        upload_id: uploadId,
        chunks: total,
        size: String(bytes.length),
        visibility: 'VISIBILITY_PRIVATE',
        capability_hash: b64(hash),
      })),
    ))) as { fileId?: string; file_id?: string };
    const fileId = done.fileId || done.file_id;
    if (!fileId) throw new V2Error('ERROR_CODE_INVALID');
    return fileId;
  }

  /** Скачать чанки блоба по секрету: анонимный канал, одноразовое соединение
   * (живёт до последнего чанка потока). */
  async function downloadBlobCap(fileId: string, capabilityB64: string, firstChunk: number, chunkCount: number) {
    if (!pv || !ready) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const method = 'cloud.blob.download_cap';
    const body = pv.encodeMessage('parvane.cloud.v1.DownloadCapRequest', JSON.stringify({
      file_id: fileId, capability: capabilityB64, first_chunk: firstChunk, chunk_count: chunkCount,
    }));
    anonPlanner = anonPlanner || new pv.PvAnonPlanner();
    const plan = anonPlanner.assign(method, body, Date.now()) as { conn: number };
    const conn = await openAnon(plan.conn);
    try {
      const parts = new Map<number, Uint8Array>();
      let streamError: string | undefined;
      let finish: NoneToVoidFunction | undefined;
      const isDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const meta = JSON.parse(pv.decodeMessage('parvane.cloud.v1.DownloadCapResponse', await conn.stream(
        method,
        body,
        (chunk) => {
          if (chunk.error) streamError = chunk.error;
          else if (chunk.data.length) parts.set(chunk.index, chunk.data);
          if (chunk.last) finish?.();
        },
        BLOB_TIMEOUT_MS,
      ))) as { size?: string | number; chunks?: number };
      // Метаданные приходят первыми; чанки — следом кадрами того же запроса
      const expected = Math.min(chunkCount, Math.max(0, (meta.chunks || 0) - firstChunk));
      if (expected > 0 && parts.size < expected && !streamError) {
        await Promise.race([isDone, pause(BLOB_TIMEOUT_MS)]);
      }
      if (streamError) throw new V2Error(streamError);
      return { size: Number(meta.size || 0), chunks: meta.chunks || 0, parts };
    } finally {
      closeAnon(plan.conn);
    }
  }

  // ── Эфемерные каналы: «печатает» (T127, FR-013/FR-064) ─────────────────────
  // Канал чата — секретный id из ключей доставки (личный чат) либо из ключа
  // конверта эпохи (группа); сервер пересылает шифртекст и не видит `{from, to}`

  /** Подписаться на каналы чата (идемпотентно: движок отдаёт только новые). */
  async function ensureEphemeral(addresses: string[]) {
    addresses.forEach((address) => ephChats.add(address));
    if (!client || !ready) return;
    const chats = {
      peers: addresses.filter((address) => !isV2GroupAddress(address)),
      groups: addresses.filter(isV2GroupAddress).map(groupHex),
    };
    try {
      await run(client.ephSubscribe(JSON.stringify(chats)) as OutReq[]);
    } catch (e) {
      deps.log(`v2: подписка на «печатает»: ${String(e)}`);
    }
  }

  function applyEphemeral(body: Uint8Array) {
    if (!client) return;
    const events = JSON.parse(client.ephOpen(body)) as {
      type: string; chat: string; group?: string; from: string; action: number; online?: boolean;
    }[];
    events.forEach((ev) => {
      if (ev.type === 'presence') {
        if (ev.online) deps.onPresence?.(ev.from);
        return;
      }
      if (ev.type !== 'typing' || ev.action === TYPING_ACTION_CANCEL) return;
      deps.onTyping?.(ev.group ? groupAddress(ev.group) : ev.from, ev.from);
    });
  }

  /** Своё присутствие («в сети») эфемерным каналом v2 (T134): видят собеседники,
   * знающие наш ключ доступа. Движок молчит, пока L2 активен хоть в одном чате. */
  async function publishPresence() {
    if (!client || !ready) return;
    try {
      await run(client.ephPresence(true, Date.now()) as OutReq[]);
    } catch (e) {
      deps.log(`v2: присутствие не отправлено: ${String(e)}`);
    }
  }

  /** Подписаться на эфемерные каналы собеседника (его присутствие и «печатает»). */
  function watchPresence(address: string) {
    void ensureEphemeral([address]);
  }

  /** «Печатает» в v2-чате. false — чат не v2 (идти по v1); true — по v1 не
   * слать, даже если сигнал не ушёл (нет канала, L2): иначе `{from, to}` увидит сервер. */
  async function trySendTyping(to: string): Promise<boolean> {
    if (!(await isV2Chat(to))) return false;
    if (!l2Gate.ephemeralAllowed(to)) return true;
    await ensureEphemeral([to]);
    try {
      const chat = isV2GroupAddress(to) ? groupHex(to) : to;
      await run(client!.ephTyping(chat, TYPING_ACTION_TYPING) as OutReq[]);
    } catch (e) {
      deps.log(`v2: «печатает» не отправлено: ${String(e)}`);
    }
    return true;
  }

  /** Отправить сообщение v2-собеседнику. Возвращает false — не v2 (идти по v1). */
  // Отправка обязана знать исход запуска v2 (T149): сообщение, ушедшее по v1,
  // пока стек поднимается, не дошло бы до v2-устройств собеседника вне каталога
  // v1. Устройство аккаунта v2, ещё не привязанное к журналу устройств (T156),
  // не отправляет вовсе — по v1 собеседники такое сообщение отвергают (D-13)
  async function ensureSendable() {
    if (!deps.isEnabled()) return;
    if (!ready && starting) await starting.catch(() => undefined);
    if (needsLinking && !ready) throw new V2Error('ERROR_CODE_UNAVAILABLE');
  }

  async function trySend(to: string, wire: WireMessageContent, uuid: string, replyTo?: string): Promise<boolean> {
    await ensureSendable();
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

  /** Кто прочитал своё сообщение чата v2 (по E2E-квитанциям; сервер v2 этого
   * не знает): адрес и время в секундах. `undefined` — движок не готов. */
  function readers(uuid: string): { address: string; ts: number }[] | undefined {
    if (!client || !ready) return undefined;
    try {
      const list = JSON.parse(client.readers(uuid)) as { user: string; tsMs: number }[];
      return list.map(({ user, tsMs }) => ({ address: user, ts: Math.floor(tsMs / 1000) }));
    } catch {
      return undefined;
    }
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
          admin_rights: m.role === 2 ? expandFlags(ADMIN_RIGHT_FIELDS, m.rights) : undefined,
        })),
        ...g.banned.map((address) => ({ address, role: 'banned' })),
      ],
      avatar: g.avatarFileId || undefined,
      about: g.about || undefined,
      default_permissions: expandFlags(PERMISSION_FIELDS, g.defaultPermissions),
      version: Number(g.version),
      pending_requests: pendingRequests.get(hex) || undefined,
      migrated_from: g.migratedFrom || undefined,
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
    // Канал «печатает» выводится из ключа эпохи — после смены эпохи он новый
    void ensureEphemeral([address]);
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

  /** Партия жетонов не больше `limit`; при исчерпанной квоте аккаунта — остаток. */
  async function requestTokens(limit: number) {
    if (!client || !serverKey) throw new V2Error('ERROR_CODE_UNAVAILABLE');
    const list = await call('anon', 'identity.tokens.key_list', new Uint8Array());
    const steps = TOKEN_BATCH_STEPS.filter((count) => count <= limit);
    if (!steps.length) steps.push(Math.max(1, limit));
    for (let i = 0; i < steps.length; i++) {
      try {
        const req = client.tokenRequest(list, serverKey, steps[i]) as OutReq;
        client.tokenResponse(await call(req.chan, req.method, req.body));
        return;
      } catch (err) {
        if (!isQuotaExceeded(err) || i === steps.length - 1) throw err;
      }
    }
  }

  /**
   * Партия жетонов по расписанию движка (FR-063): заранее, а не перед тратой —
   * иначе выдача (с личностью) связывается по времени с анонимной доставкой.
   */
  async function refillTokens() {
    if (!client || !serverKey || !ready || !client.tokenRefillDue()) return;
    try {
      await requestTokens(Math.min(TOKEN_BATCH, client.tokenBatchSize()));
      deps.log(`v2: жетоны — партия по расписанию получена (запас ${client.tokenCount()})`);
    } catch (err) {
      // Срок следующей партии движок уже сдвинул — «дозапроса» не будет (D-06)
      deps.log(`v2: жетоны — партия по расписанию не получена: ${String(err)}`);
    }
    await persist();
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
  async function createGroup(
    title: string, members: string[], kind: 'group' | 'channel',
    migratedFrom?: string, permissions?: WireDefaultPermissions,
  ) {
    if (!ready || !client || !pv) return undefined;
    for (const member of members) {
      if (!(await isV2Peer(member).catch(() => false))) return undefined;
    }
    return serial(async () => {
      // Права переводимой группы v1 — сразу в запись генезиса: отдельная запись
      // `set_permissions` потребовала бы новой эпохи (не чаще раза в 10 с)
      const perms = kind === 'channel' ? {} : (permissions || DEFAULT_GROUP_PERMISSIONS);
      const known = new Set(client!.groupList());
      const created = client!.groupCreate(
        kind === 'channel' ? GROUP_KIND_CHANNEL : GROUP_KIND_GROUP, title, members, JSON.stringify(perms), migratedFrom,
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

  /**
   * Перевод группы v1 в v2 (T180). Делает владелец, когда все участники на v2 и ни
   * у кого не осталось v1-устройств: группа v2 с тем же составом и записью о
   * прежнем `group_id`, затем описание, фото, права и админы. Клиенты участников
   * продолжают прежний чат. Возвращает сведения новой группы; undefined — рано
   * (кто-то ещё на v1) либо перевод уже сделан.
   */
  async function migrateGroup(v1: WireGroupInfo) {
    if (!ready || !client) return undefined;
    const self = deps.getSelf();
    if (v1.created_by !== self) return undefined;
    const already = client.groupList().some((hex) => readGroup(hex)?.migratedFrom === v1.group_id);
    if (already) return undefined;
    const active = v1.members.filter(({ role }) => role !== 'banned' && role !== 'left');
    const others = active.map(({ address }) => address).filter((address) => address !== self);
    for (const member of [self, ...others]) {
      if (legacyDevices(member).size) return undefined;
    }
    const created = await createGroup(v1.name, others, v1.kind, v1.group_id, v1.default_permissions);
    if (!created) return undefined;
    const address = created.group_id;
    deps.log(`v2: группа v1 ${v1.group_id} переведена в ${address}`);
    // Доводка сведений: сбой любой записи не отменяет перевод — владелец поправит руками
    const step = async (what: string, apply: () => Promise<unknown>) => {
      try {
        await apply();
      } catch (e) {
        deps.log(`v2: перевод группы — ${what} не перенесено: ${String(e)}`);
      }
    };
    if (v1.about || v1.avatar) {
      await step('описание и фото', () => setGroupInfo(address, { about: v1.about, avatarFileId: v1.avatar }));
    }
    const fullRights = Object.fromEntries(ADMIN_RIGHT_FIELDS.map((field) => [field, true]));
    for (const member of active) {
      if (member.role !== 'admin' || member.address === self) continue;
      await step(`админ ${member.address}`, () => changeGroup(address, {
        set_role: {
          member: { address: member.address },
          role: 'ROLE_ADMIN',
          rights: member.admin_rights || fullRights,
        },
      }));
    }
    return groupInfo(address);
  }

  /** Изменение группы записью журнала (proto3-JSON `group.v2.GroupChange`). */
  async function changeGroup(address: string, change: Record<string, unknown>) {
    if (!ready || !client || !isV2GroupAddress(address)) return false;
    const hex = groupHex(address);
    return serial(() => applyGroupChange(hex, change));
  }

  /**
   * Имя, описание и фото группы — одна запись `set_info` со всеми тремя полями.
   * Недостающие берутся из журнала ВНУТРИ очереди: две правки подряд (экран
   * «Edit» шлёт название и описание одновременно), собранные по снимку «до»,
   * откатывали друг друга — вторая возвращала прежнее название.
   */
  async function setGroupInfo(address: string, patch: { name?: string; about?: string; avatarFileId?: string }) {
    if (!ready || !client || !isV2GroupAddress(address)) return false;
    const hex = groupHex(address);
    return serial(async () => {
      const current = readGroup(hex);
      if (!current) return false;
      const next = {
        name: patch.name ?? current.name,
        about: patch.about ?? current.about ?? '',
        avatar_file_id: patch.avatarFileId ?? current.avatarFileId ?? '',
      };
      const isSame = next.name === current.name && next.about === (current.about || '')
        && next.avatar_file_id === (current.avatarFileId || '');
      // Ничего не меняется — записи в журнале не будет (право всё равно проверил бы движок)
      return isSame ? true : applyGroupChange(hex, { set_info: next });
    });
  }

  async function applyGroupChange(hex: string, change: Record<string, unknown>) {
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
    // Порядок один на всех своих устройствах (T160): по нему выбирается основная ссылка
    return ((await loadInvites())[address] || []).filter(({ linkId }) => active.has(linkId)).sort(compareInvites);
  }

  /** Все действующие ссылки этого устройства — для журнала личного состояния (T160). */
  async function allInvites(): Promise<V2SharedInvite[]> {
    if (!client) return [];
    const out: V2SharedInvite[] = [];
    Object.entries(await loadInvites()).forEach(([address, records]) => {
      const active = new Set(readGroup(groupHex(address))?.inviteLinks || []);
      records.filter(({ linkId }) => active.has(linkId)).forEach((record) => out.push({ address, record }));
    });
    return out;
  }

  /** Ссылки, созданные другими своими устройствами (секрет знает только создатель). */
  async function mergeSharedInvites(shared: V2SharedInvite[]) {
    if (!storage || !shared.length) return;
    await serial(async () => {
      const all = await loadInvites();
      let added = 0;
      shared.forEach(({ address, record }) => {
        const list = all[address] || [];
        if (list.some(({ linkId }) => linkId === record.linkId)) return;
        all[address] = [...list, record];
        added += 1;
      });
      if (!added) return;
      await storage!.saveRecord(INVITES_RECORD, all);
      deps.log(`v2: ссылки-приглашения с других своих устройств: ${added}`);
    });
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
      deps.onInviteCreated?.(address, record);
      return record;
    });
  }

  async function revokeInvite(address: string, url: string) {
    const record = (await loadInvites())[address]?.find((item) => item.url === url);
    if (!record) return false;
    const isDone = await changeGroup(address, { invite_key_revoke: { link_id: hexToB64(record.linkId) } });
    if (isDone) deps.onInviteRevoked?.(record.linkId);
    return isDone;
  }

  // ── заявки на вступление (ссылка с одобрением, D-04; T143) ──────────────────
  // Сервер держит список заявок и отдаёт его админам с правом приглашать;
  // одобрение — запись `AddMember` журнала внутри `group.request.decide`.
  // О новой заявке сервер сообщает уведомлением о группе без смены версии.

  function canDecideRequests(hex: string) {
    const g = readGroup(hex);
    const self = deps.getSelf();
    const me = g?.members.find(({ user }) => user === self);
    return Boolean(g && !g.deleted && me && (g.owner === self || (me.role === 2 && me.rights?.invite_users)));
  }

  function notePendingRequests(hex: string, count: number) {
    if ((pendingRequests.get(hex) || 0) === count) return;
    pendingRequests.set(hex, count);
    publishGroup(hex);
  }

  async function listJoinRequests(address: string): Promise<V2JoinRequest[] | undefined> {
    if (!ready || !client || !pv || !isV2GroupAddress(address)) return undefined;
    const hex = groupHex(address);
    if (!canDecideRequests(hex)) return [];
    try {
      const resp = await call('id', 'group.request.list', pv.encodeMessage(
        'parvane.group.v2.RequestListRequest', JSON.stringify({ group: { domain: serverDomain, id: hexToB64(hex) } }),
      ));
      const list = JSON.parse(pv.decodeMessage('parvane.group.v2.RequestListResponse', resp)) as {
        requests?: { user?: { address?: string }; requested_ms?: string | number; requestedMs?: string | number }[];
      };
      const requests = (list.requests || [])
        .filter((item) => item.user?.address)
        .map((item) => ({
          user: item.user!.address!,
          date: Math.floor(Number(item.requested_ms ?? item.requestedMs ?? 0) / 1000),
        }));
      notePendingRequests(hex, requests.length);
      return requests;
    } catch (e) {
      deps.log(`v2: список заявок группы ${hex} не получен: ${String(e)}`);
      return undefined;
    }
  }

  async function decideJoinRequest(address: string, user: string, approve: boolean) {
    if (!ready || !client || !isV2GroupAddress(address)) return false;
    const hex = groupHex(address);
    return serial(async () => {
      let req: OutReq;
      try {
        req = client!.groupRequestDecide(hex, user, approve) as OutReq;
      } catch (e) {
        deps.log(`v2: решение по заявке отклонено движком: ${String(e)}`);
        return false;
      }
      try {
        await call(req.chan, req.method, req.body);
      } catch (e) {
        deps.log(`v2: решение по заявке отклонено сервером: ${String(e)}`);
        if (approve) await resyncGroup(hex);
        return false;
      }
      deps.log(`v2: заявка ${user} в группу ${hex} — ${approve ? 'одобрена' : 'отклонена'}`);
      // Новый участник — ключи прежней эпохи ему не отдаются, нужна новая
      if (approve && readGroup(hex)?.epochStale && canRotate(hex)) {
        await rotateEpoch(hex).catch((e: unknown) => {
          deps.log(`v2: новая эпоха после одобрения заявки не начата: ${String(e)}`);
          scheduleRotate(hex, EPOCH_RETRY_MS);
        });
      }
      await persist();
      pendingRequests.set(hex, Math.max(0, (pendingRequests.get(hex) || 1) - 1));
      publishGroup(hex);
      return true;
    });
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
      // Описание и фото — из подписанного журнала группы (сервер отдаёт его по
      // ссылке), а не со слов сервера; журнал не-участника после чтения не храним
      let preview: { about?: string; avatar?: string } | undefined;
      if (hex && !readGroup(hex)?.members.some(({ user }) => user === self)) {
        preview = await serial(async () => {
          await syncGroup(hex, parsed.linkId);
          const g = readGroup(hex);
          client!.groupForget(hex);
          return { about: g?.about || undefined, avatar: g?.avatarFileId || undefined };
        }).catch(() => undefined);
      }
      return {
        address: groupAddress(hex),
        about: preview?.about,
        avatar: preview?.avatar,
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
  function logDevices(user: string): LogDevices | undefined {
    if (!client || !ready) return undefined;
    const devices = JSON.parse(client.logDevices(user)) as LogDevices;
    return devices.v2.length ? devices : undefined;
  }

  /** Подписанный список v1-устройств пользователя: id → identity-ключ (FR-058). */
  function legacyDevices(user: string): Map<string, string> {
    return new Map((logDevices(user)?.legacyKeys || []).map((d) => [d.deviceId, d.identity]));
  }

  // Свой список v1-устройств (FR-054/FR-058): первое v2-устройство публикует
  // его в журнале устройств, и v2-собеседники шлют этим устройствам копии по
  // v1. Дальше список только сокращается (устройство перешло на v2 или
  // исчезло) — появившееся позже v1-устройство копий не получит
  async function syncLegacySet() {
    if (!client || !ready || !deps.listOwnV1Devices) return;
    const own = logDevices(deps.getSelf());
    if (!own) return;
    const stripPadding = (key: string) => key.replace(/=+$/, '');
    let candidates: { deviceId: string; identity: string; signing: string }[];
    try {
      candidates = (await deps.listOwnV1Devices())
        .filter((d) => d.deviceId && d.identity && d.signing && !own.v2.includes(d.deviceId))
        .map((d) => ({ deviceId: d.deviceId, identity: stripPadding(d.identity), signing: stripPadding(d.signing) }));
    } catch {
      return;
    }
    let next: typeof candidates;
    if (!own.legacySet) {
      if (!candidates.length) return;
      next = candidates;
    } else {
      next = own.legacyKeys.filter((k) => (
        candidates.some((d) => d.deviceId === k.deviceId && d.identity === k.identity)
      ));
      if (next.length === own.legacyKeys.length) return;
    }
    try {
      const req = client.legacyDevicesRequest(JSON.stringify(next)) as OutReq;
      await call(req.chan, req.method, req.body);
      // Запись попадает в свой журнал синком — только после подтверждения сервера
      await checkOwnDevices();
      deps.log(`v2: список v1-устройств опубликован (${next.length})`);
    } catch (e) {
      // Нет SSK на этом устройстве либо журнал ушёл вперёд — догонит другое устройство
      deps.log(`v2: список v1-устройств не опубликован: ${String(e)}`);
    }
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
  async function setPrivacy(settings: {
    groupAdd: 'anyone' | 'nobody'; strangers: boolean; callsFrom: 'anyone' | 'nobody'; presence: 'anyone' | 'nobody';
  }) {
    if (!pv || !ready) return false;
    const audience = (value: 'anyone' | 'nobody') => (value === 'nobody' ? 'AUDIENCE_NOBODY' : 'AUDIENCE_EVERYBODY');
    await call('id', 'identity.privacy.set', pv.encodeMessage('parvane.identity.v2.PrivacySetRequest', JSON.stringify({
      settings: {
        group_add: audience(settings.groupAdd),
        messages_from_strangers: settings.strangers,
        calls_from: audience(settings.callsFrom),
        presence_visibility: audience(settings.presence),
      },
    })));
    return true;
  }

  // Свои настройки с сервера (FR-040): заданное на другом устройстве не должно
  // перетираться локальным значением этого. `undefined` — ни разу не задавались
  async function getPrivacy() {
    if (!pv || !ready) return undefined;
    const got = JSON.parse(pv.decodeMessage('parvane.identity.v2.PrivacyGetResponse', await call(
      'id', 'identity.privacy.get', pv.encodeMessage('parvane.identity.v2.PrivacyGetRequest', '{}'),
    ))) as {
      settings?: {
        group_add?: string; messages_from_strangers?: boolean; calls_from?: string; presence_visibility?: string;
      };
      is_set?: boolean;
    };
    if (!got.is_set) return undefined;
    const audience = (value?: string) => (value === 'AUDIENCE_NOBODY' ? 'nobody' as const : 'anyone' as const);
    return {
      groupAdd: audience(got.settings?.group_add),
      strangers: Boolean(got.settings?.messages_from_strangers),
      // FR-040 (T137): «кто может звонить» и «кто видит, что я в сети» — их
      // соблюдает клиент владельца (сервер v2 не видит ни звонящего, ни зрителя)
      callsFrom: audience(got.settings?.calls_from),
      presence: audience(got.settings?.presence_visibility),
    };
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
      const material = client.linkGrantMaterial();
      if (!rootBackupB64 || !pv) return material;
      // Копия корня под ключом восстановления — вместе с грантом (поле `rb`)
      const withBackup = pv.grantWithRootBackup(material, unb64(rootBackupB64));
      material.fill(0);
      return withBackup;
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
    revokeDevice,
    revokeContactAccess,
    sskState,
    rotateSsk,
    recoverWithKey,
    resetIdentity,
    exportBackup,
    importBackup,
    cachedGroups,
    migrateGroup,
    changeGroup,
    setGroupInfo,
    checkInvite,
    createGroup,
    createInvite,
    groupInfo,
    joinByInvite,
    listInvites,
    allInvites,
    mergeSharedInvites,
    listJoinRequests,
    decideJoinRequest,
    reportUnconfirmed: (address: string, claimed: string[]) => {
      if (client && isV2GroupAddress(address)) reportUnconfirmed(groupHex(address), claimed);
    },
    revokeInvite,
    isV2GroupAddress,
    isV2Chat,
    isV2InviteUrl: (url: string) => Boolean(parseV2Invite(url)) || V2_INVITE_REGEX.test(url.trim()),
    logDevices,
    legacyDevices,
    deliverLegacy,
    pushRegister,
    pushUnregister,
    setPrivacy,
    getPrivacy,
    // Режим «усиленная приватность» (L2): состояние чата и правило L2-1
    l2State: l2Gate.state,
    ephemeralAllowed: l2Gate.ephemeralAllowed,
    presenceAllowed: l2Gate.presenceAllowed,
    setDirectL2,
    setGroupL2,
    isV2Peer,
    readers,
    trySend,
    trySendCall,
    uploadBlob,
    downloadBlobCap,
    trySendTyping,
    publishPresence,
    watchPresence,
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
      rootBackupB64 = undefined;
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
      pendingRequests.clear();
      rotateTimers.forEach((timer) => clearTimeout(timer));
      rotateTimers.clear();
      groupResyncTimers.forEach((timer) => clearTimeout(timer));
      groupResyncTimers.clear();
      if (tokenTimer) clearInterval(tokenTimer);
      tokenTimer = undefined;
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

function compareInvites(a: V2InviteRecord, b: V2InviteRecord) {
  return a.date - b.date || (a.linkId < b.linkId ? -1 : 1);
}

function isForbidden(e: unknown) {
  return /Forbidden|FORBIDDEN/.test(e instanceof V2Error ? e.code : String(e));
}

function isQuotaExceeded(e: unknown) {
  return /ERROR_CODE_LIMIT\b/.test(e instanceof V2Error ? e.code : String(e));
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
