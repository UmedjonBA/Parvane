// Протокол v2 (spec 007, T098, R10): папки, блок-лист, черновики, отложенные,
// архив и закреп — из журнала личного состояния (`state.append`/`state.sync`,
// шифртекст на ключе личного состояния; сведение LWW — STATE-1 в движке).
// localState остаётся рабочей копией для UI: правка пользователя → разница с
// сведённым состоянием → записи журнала; записи других устройств → сведённый
// снимок → localState и нативные апдейты UI. Первый запуск переносит
// локальные данные в журнал (движок: migrate_snapshot). Без v2-стека
// журнал не подключается — всё как раньше.

import type { ApiChatFolder, ApiDraft, ApiMessageEntity, ApiUpdate } from '../../types';
import type { createLocalState, JournalScheduled, LocalStateKind } from '../localState';
import type { ParvaneStore } from '../store';
import type { WireCallRecord } from '../wire';
import type { V2SharedInvite } from './controller';
import type { PvState } from './engine';
import { MAIN_THREAD_ID } from '../../types';

import { ARCHIVED_FOLDER_ID } from '../../../config';
import { apiEntitiesToWire, wireEntitiesToApi } from '../entities';
import {
  b64ToUuid, uuidToB64, type V2Content, type V2Text, v2ToWire, wireToV2,
} from './contentMap';
import { isV2GroupAddress } from './controller';

/** Что журналу нужно от v2-стека (контроллер). */
export type StateJournalHost = {
  openSession: () => PvState | undefined;
  call: (method: string, body: Uint8Array) => Promise<Uint8Array>;
  encode: (type: string, json: string) => Uint8Array;
  decode: (type: string, bytes: Uint8Array) => string;
  domain: () => string;
  log: (message: string) => void;
};

type LocalState = ReturnType<typeof createLocalState>;

type Deps = {
  localState: LocalState;
  getStore: () => ParvaneStore;
  sendUpdate: (update: ApiUpdate) => void;
  /** История звонков из журнала (D-08: сервер её не ведёт) — записи в чаты. */
  applyCallRecords?: (records: WireCallRecord[]) => void;
  /** Чат очищен на другом своём устройстве: скрыть сообщения не позже границы (мс). */
  applyChatCleared?: (address: string, untilMs: number) => void;
  /** Ссылки-приглашения групп v2 (T160): действующие ссылки этого устройства и
   * приём ссылок, созданных другими своими устройствами. */
  sharedInvites?: {
    list: () => Promise<V2SharedInvite[]>;
    merge: (invites: V2SharedInvite[]) => Promise<void>;
  };
  log: (message: string) => void;
};

// proto3-JSON `state.v1.*` (имена полей схемы, bytes — base64, int64 — строки)
type SPeer = { user?: { address: string }; group?: { domain: string; id: string } };
type SFolder = {
  id: number;
  title?: string;
  emoticon?: string;
  include_peers?: SPeer[];
  exclude_peers?: SPeer[];
  pinned_peers?: SPeer[];
  contacts?: boolean;
  non_contacts?: boolean;
  groups?: boolean;
  channels?: boolean;
  bots?: boolean;
  exclude_muted?: boolean;
  exclude_read?: boolean;
  exclude_archived?: boolean;
  color?: number;
};
type SDraft = { peer?: SPeer; text?: string; reply_to_op_id?: string; date_ms?: string };
type SScheduled = { op_id?: string; peer?: SPeer; send_at_ms?: string; content?: string };
type SPinned = { list?: string | number; peers?: SPeer[] };
type SCall = {
  call_id?: string;
  peer?: SPeer;
  outgoing?: boolean;
  video?: boolean;
  reason?: string | number;
  started_ms?: string;
  duration_s?: number;
};
type SSnapshot = {
  folders?: SFolder[];
  folder_order?: { ids?: number[] };
  blocked?: { peer?: SPeer; blocked_at_ms?: string }[];
  drafts?: SDraft[];
  scheduled?: SScheduled[];
  scheduled_sent?: string[];
  archived?: SPeer[];
  pinned?: SPinned[];
  calls?: SCall[];
  cleared?: { peer?: SPeer; cleared_until_ms?: string }[];
  invites?: SInvite[];
  notify?: { peer?: SPeer; settings?: SNotify }[];
  notify_defaults?: { users?: SNotify; groups?: SNotify; channels?: SNotify };
  [key: string]: unknown;
};
// `state.v1.GroupInvite`: ссылка-приглашение группы v2 (bytes — base64)
type SInvite = {
  group_id?: string;
  link_id?: string;
  url?: string;
  created_ms?: string;
  title?: string;
  expires_ms?: string;
  usage_limit?: number;
  requires_approval?: boolean;
};
// `state.v1.NotifySettings`: без звука до момента (мс эпохи, int64 — строкой)
type SNotify = { mute_until_ms?: string; sound?: string; show_previews?: boolean; silent?: boolean };
// Локальный вид настроек уведомлений чата (поля ApiPeerNotifySettings)
type LocalNotify = Record<string, unknown>;
const NOTIFY_DEFAULT_TYPES = ['users', 'groups', 'channels'] as const;

const MANAGED_KINDS: LocalStateKind[] = [
  'folders', 'blocked', 'drafts', 'scheduled', 'archived', 'pinned', 'notify',
];
const PIN_LIST_MAIN = 'PIN_LIST_MAIN';
// Причина завершения звонка (`call.v2.HangupReason`): имя и числовое значение
const HANGUP_NORMAL = 'HANGUP_REASON_NORMAL';
const HANGUP_DECLINED = 'HANGUP_REASON_DECLINED';
const HANGUP_BUSY = 'HANGUP_REASON_BUSY';
const HANGUP_MISSED = 'HANGUP_REASON_MISSED';
const HANGUP_BY_NUMBER = [undefined, HANGUP_NORMAL, HANGUP_DECLINED, HANGUP_BUSY, HANGUP_MISSED];
const PIN_LIST_MAIN_NUMBER = 1;
const NO_COLOR = -1;
const ALL_CHATS_FOLDER_ID = 0;
const MS_IN_SECOND = 1000;
const FLUSH_DELAY_MS = 700;
// SC-009: правка с другого устройства видна ≤ 10 с (запись 0,7 с + опрос);
// живого события об изменении журнала в протоколе нет — только опрос
const SYNC_INTERVAL_MS = 8000;
const SYNC_PAGES = 1000;
const V2_GROUP_PREFIX = 'v2g:';
const UUID_HEX_LENGTH = 32;

export function createStateJournal(deps: Deps) {
  let host: StateJournalHost | undefined;
  let session: PvState | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  // Записи, не принятые сервером (обрыв): повтор тем же op_id идемпотентен
  const pendingAppends: Uint8Array[] = [];

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  function migratedKey() {
    return `parvane:v2state-migrated:${deps.getStore().self}`;
  }

  function isMigrated() {
    try {
      return localStorage.getItem(migratedKey()) === '1';
    } catch {
      return false;
    }
  }

  // Вид `notify` (T132) появился позже первого переноса: на устройстве, уже
  // перенёсшем состояние, локальные настройки уведомлений уходят в журнал один
  // раз — иначе первая же проекция журнала (в нём их ещё нет) стёрла бы их
  function kindMigratedKey(kind: LocalStateKind) {
    return `${migratedKey()}:${kind}`;
  }

  function markKindMigrated(kind: LocalStateKind) {
    try {
      localStorage.setItem(kindMigratedKey(kind), '1');
    } catch {
      // приватный режим — перенос повторится и сойдётся (LWW)
    }
  }

  async function migrateNotify() {
    if (!session) return;
    try {
      if (localStorage.getItem(kindMigratedKey('notify')) === '1') return;
    } catch {
      // приватный режим — переносим
    }
    const current = readSnapshot();
    if (!current.notify?.length && !current.notify_defaults) {
      const desired = buildDesired(current);
      const bodies = session.diff(
        JSON.stringify({ ...current, notify: desired.notify, notify_defaults: desired.notify_defaults }),
        ['notify'],
      );
      pendingAppends.push(...bodies);
      await pushAppends();
      if (bodies.length) deps.log(`v2: настройки уведомлений перенесены в журнал (${bodies.length} записей)`);
    }
    markKindMigrated('notify');
  }

  function markMigrated() {
    try {
      localStorage.setItem(migratedKey(), '1');
    } catch {
      // приватный режим — повторная миграция сходится (union по LWW)
    }
  }

  // `rekey` — ключ личного состояния сменён (отзыв устройства, D-16):
  // 'self' — этим устройством: сведённое состояние переносится записями под
  // новым ключом (старые записи новым ключом не читаются); 'peer' — другим
  // своим устройством: ждём его записей, локальное состояние не трогаем
  async function attach(nextHost: StateJournalHost, rekey?: 'self' | 'peer') {
    const carried = rekey === 'self' && session ? session.snapshot() : undefined;
    detach();
    const nextSession = nextHost.openSession();
    if (!nextSession) {
      deps.log('v2: журнал состояния недоступен — нет ключа личного состояния');
      return;
    }
    host = nextHost;
    session = nextSession;
    await serial(async () => {
      const isReadable = await pullRemote();
      if (carried) {
        const bodies = session!.migrate(carried);
        pendingAppends.push(...bodies);
        await pushAppends();
        deps.log(`v2: журнал состояния перенесён под новый ключ (${bodies.length} записей)`);
      } else if (rekey && !isReadable) {
        // Записей под новым ключом ещё нет: пустой снимок стёр бы локальные
        // папки и блок-лист — проекция после первого удачного синка
        return;
      }
      if (!isMigrated()) {
        // Первый запуск на v2: локальные данные — начальными записями журнала
        const revision = deps.localState.getDirtyRevision();
        const bodies = session!.migrate(JSON.stringify(buildDesired({})));
        pendingAppends.push(...bodies);
        await pushAppends();
        markMigrated();
        markKindMigrated('notify');
        deps.localState.clearDirtyKinds(revision);
        deps.log(`v2: локальное состояние перенесено в журнал (${bodies.length} записей)`);
      }
      await migrateNotify();
      await flushDirty();
      project();
    }).catch((e: unknown) => deps.log(`v2: журнал состояния не прочитан: ${String(e)}`));
    deps.localState.setChangeListener(scheduleFlush);
    deps.localState.setScheduledHooks({ gate: canSendScheduled, sent: markScheduledSent });
    syncTimer = setInterval(() => {
      void syncNow().catch((e: unknown) => deps.log(`v2: синк журнала состояния: ${String(e)}`));
    }, SYNC_INTERVAL_MS);
    deps.log('v2: журнал состояния подключён');
  }

  function isAttached() {
    return Boolean(session);
  }

  function detach() {
    if (flushTimer) clearTimeout(flushTimer);
    if (syncTimer) clearInterval(syncTimer);
    flushTimer = undefined;
    syncTimer = undefined;
    deps.localState.setChangeListener(undefined);
    deps.localState.setScheduledHooks(undefined);
    session?.free();
    session = undefined;
    host = undefined;
    pendingAppends.length = 0;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void serial(flushLocal).catch((e: unknown) => deps.log(`v2: запись журнала состояния: ${String(e)}`));
    }, FLUSH_DELAY_MS);
  }

  /** Своя правка — сначала в журнал, затем чужие записи (иначе снимок откатит её). */
  function syncNow() {
    return serial(async () => {
      await flushLocal();
      if (await pullRemote()) project();
    });
  }

  async function flushLocal() {
    if (!session) return;
    const revision = deps.localState.getDirtyRevision();
    const current = readSnapshot();
    const bodies = session.diff(JSON.stringify(buildDesired(current)), MANAGED_KINDS);
    pendingAppends.push(...bodies);
    await pushAppends();
    deps.localState.clearDirtyKinds(revision);
  }

  // Подключение журнала: правки, сделанные до него (перед перезагрузкой, пока
  // v2 поднимался, без сети), уходят в журнал ДО проекции снимка — иначе снимок
  // их затрёт. Только несохранённые виды: остальные могли смениться на другом
  // устройстве, и локальная копия там устарела
  async function flushDirty() {
    if (!session) return;
    const kinds = deps.localState.loadDirtyKinds().filter((kind) => MANAGED_KINDS.includes(kind));
    if (!kinds.length) return;
    const revision = deps.localState.getDirtyRevision();
    const bodies = session.diff(JSON.stringify(buildDesired(readSnapshot())), kinds);
    pendingAppends.push(...bodies);
    await pushAppends();
    deps.localState.clearDirtyKinds(revision);
    deps.log(`v2: несохранённые правки (${kinds.join(', ')}) дописаны в журнал (${bodies.length} записей)`);
  }

  async function pushAppends() {
    while (host && pendingAppends.length) {
      await host.call('state.append', pendingAppends[0]);
      pendingAppends.shift();
    }
  }

  /** Записи журнала после курсора → сведённое состояние. true — что-то применено. */
  async function pullRemote() {
    if (!session || !host) return false;
    let applied = 0;
    for (let page = 0; page < SYNC_PAGES; page++) {
      const resp = await host.call('state.sync', session.syncRequest());
      const result = JSON.parse(session.ingest(resp)) as { more: boolean; applied: number; rejected: number };
      applied += result.applied;
      if (!result.more) break;
    }
    return applied > 0;
  }

  function readSnapshot(): SSnapshot {
    if (!session) return {};
    try {
      return JSON.parse(session.snapshot()) as SSnapshot;
    } catch {
      return {};
    }
  }

  // ── отложенные: отправляет первое устройство, заметившее срок ─────────────

  async function canSendScheduled(opId: string) {
    if (!session) return true;
    await syncNow().catch(() => undefined);
    return !(readSnapshot().scheduled_sent || []).includes(uuidToB64(opId));
  }

  function markScheduledSent(opId: string) {
    void serial(async () => {
      if (!session) return;
      pendingAppends.push(...session.markSent(uuidToB64(opId)));
      await pushAppends();
    }).catch((e: unknown) => deps.log(`v2: отметка отправки отложенного: ${String(e)}`));
  }

  // ── история звонков (D-08): явная запись, не разница снимков ──────────────

  /** Завершённый звонок по v2 — в журнал: виден на всех своих устройствах и после reload. */
  // ── контейнер планировщика (spec 010) ──────────────────────────────────────

  /** Контейнер планировщика, объявленный любым своим устройством: {domain, id(hex)}. */
  function plannerContainer(): { domain: string; id: string } | undefined {
    const ref = (readSnapshot().planner_container as { ref?: { domain?: string; id?: string } } | undefined)?.ref;
    if (!ref?.domain || !ref.id) return undefined;
    return { domain: ref.domain, id: b64ToHex(ref.id) };
  }

  /** Объявить свой контейнер планировщика (LWW-регистр, один на пользователя). */
  function recordPlannerContainer(ref: { domain: string; id: string }) {
    void serial(async () => {
      if (!session) return;
      pendingAppends.push(...session.plannerContainerSet(ref.domain, ref.id));
      await pushAppends();
    }).catch((e: unknown) => deps.log(`v2: запись контейнера планировщика в журнал состояния: ${String(e)}`));
  }

  function recordCall(record: WireCallRecord) {
    void serial(async () => {
      if (!session) return;
      const body = callToState(record);
      if (!body) return;
      pendingAppends.push(...session.callSet(JSON.stringify(body)));
      await pushAppends();
    }).catch((e: unknown) => deps.log(`v2: запись звонка в журнал состояния: ${String(e)}`));
  }

  // ── «удалить чат у себя» (T145): явная запись, граница только растёт ───────

  /** Чат очищен на этом устройстве — остальные свои скроют сообщения не позже `untilMs`. */
  function recordChatCleared(address: string, untilMs: number) {
    deps.localState.saveClearedUntil(address, untilMs);
    void serial(async () => {
      if (!session) return;
      const peer = peerOf(address);
      if (!peer) return;
      pendingAppends.push(...session.chatCleared(JSON.stringify({ peer, cleared_until_ms: String(untilMs) })));
      await pushAppends();
    }).catch((e: unknown) => deps.log(`v2: запись очистки чата в журнал состояния: ${String(e)}`));
  }

  // ── ссылки-приглашения групп v2 (T160) ─────────────────────────────────────
  // Секрет ссылки знает только создавшее её устройство: запись журнала делит
  // ссылку между своими устройствами (в v1 основная ссылка у аккаунта одна).

  function recordGroupInvite({ address, record }: V2SharedInvite) {
    void serial(async () => {
      if (!session || !isV2GroupAddress(address)) return;
      pendingAppends.push(...session.groupInviteSet(JSON.stringify(inviteToState(address, record))));
      await pushAppends();
    }).catch((e: unknown) => deps.log(`v2: запись ссылки-приглашения в журнал состояния: ${String(e)}`));
  }

  function removeGroupInvite(linkId: string) {
    void serial(async () => {
      if (!session) return;
      pendingAppends.push(...session.groupInviteRemove(hexToB64(linkId)));
      await pushAppends();
    }).catch((e: unknown) => deps.log(`v2: снятие ссылки-приглашения в журнале состояния: ${String(e)}`));
  }

  async function projectInvites(snap: SSnapshot) {
    if (!deps.sharedInvites) return;
    const shared = (snap.invites || []).map(inviteFromState).filter((item): item is V2SharedInvite => Boolean(item));
    await deps.sharedInvites.merge(shared);
    // Ссылки этого устройства, которых в журнале ещё нет (созданы до T160)
    const known = new Set(shared.map(({ record }) => record.linkId));
    (await deps.sharedInvites.list()).filter(({ record }) => !known.has(record.linkId)).forEach(recordGroupInvite);
  }

  function projectCleared(snap: SSnapshot) {
    (snap.cleared || []).forEach((entry) => {
      const address = addressOf(entry.peer);
      const untilMs = Number(entry.cleared_until_ms || 0);
      if (!address || !(untilMs > 0)) return;
      if (deps.localState.saveClearedUntil(address, untilMs)) deps.applyChatCleared?.(address, untilMs);
    });
  }

  function callToState(record: WireCallRecord): SCall | undefined {
    const self = deps.getStore().self;
    const isOutgoing = record.caller === self;
    const peer = peerOf(isOutgoing ? record.callee : record.caller);
    if (!peer?.user) return undefined;
    const isEnded = record.status === 'ended';
    return {
      call_id: uuidToB64(record.call_id),
      peer,
      outgoing: isOutgoing,
      video: record.media === 'video',
      reason: isEnded ? HANGUP_NORMAL : record.status === 'rejected' ? HANGUP_DECLINED : HANGUP_MISSED,
      started_ms: String(record.started_at * MS_IN_SECOND),
      duration_s: isEnded && record.ended_at ? Math.max(1, record.ended_at - record.started_at) : 0,
    };
  }

  function stateToCall(call: SCall): WireCallRecord | undefined {
    const callId = b64ToUuid(call.call_id);
    const peer = call.peer?.user?.address;
    if (!callId || !peer) return undefined;
    const self = deps.getStore().self;
    const reason = typeof call.reason === 'number' ? HANGUP_BY_NUMBER[call.reason] : call.reason;
    const startedAt = Math.floor(Number(call.started_ms || 0) / MS_IN_SECOND);
    const status = reason === HANGUP_MISSED ? 'missed'
      : (reason === HANGUP_DECLINED || reason === HANGUP_BUSY) ? 'rejected' : 'ended';
    return {
      call_id: callId,
      caller: call.outgoing ? self : peer,
      callee: call.outgoing ? peer : self,
      media: call.video ? 'video' : 'audio',
      status,
      started_at: startedAt,
      ended_at: status === 'ended' ? startedAt + (call.duration_s || 0) : undefined,
    };
  }

  function projectCalls(snap: SSnapshot) {
    const records = (snap.calls || []).map(stateToCall).filter((r): r is WireCallRecord => Boolean(r));
    if (records.length) deps.applyCallRecords?.(records.sort((a, b) => a.started_at - b.started_at));
  }

  // ── локальные данные → желаемый снимок ───────────────────────────────────

  function buildDesired(current: SSnapshot): SSnapshot {
    const { localState } = deps;
    const store = deps.getStore();
    const folders = localState.loadFolders() as unknown as ApiChatFolder[];
    const blockedAt = new Map((current.blocked || []).map((b) => [peerKey(b.peer), b.blocked_at_ms]));
    const now = String(Date.now());
    const pinnedOther = (current.pinned || []).filter((p) => !isMainPinList(p.list));
    return {
      ...current,
      folders: folders.map(folderToState).filter((f): f is SFolder => Boolean(f)),
      folder_order: { ids: folders.map(({ id }) => id) },
      blocked: localState.loadBlocked().map(peerOf).filter(isPeer).map((peer) => ({
        peer, blocked_at_ms: blockedAt.get(peerKey(peer)) || now,
      })),
      drafts: Object.entries(localState.loadDrafts()).map(([address, draft]) => draftToState(address, draft))
        .filter((d): d is SDraft => Boolean(d)),
      scheduled: localState.listJournalScheduled().map((entry) => scheduledToState(entry, store))
        .filter((x): x is SScheduled => Boolean(x)),
      archived: localState.loadArchived().map(peerOf).filter(isPeer),
      // Настройки уведомлений (FR-039): кто заглушён — только своим устройствам,
      // сервер этого не видит (v1-блоб `msg.chat.setnotify` был открытым)
      notify: Object.entries(localState.loadNotifyExceptions())
        .map(([address, settings]) => ({ peer: peerOf(address), settings: notifyToState(settings) }))
        .filter((entry): entry is { peer: SPeer; settings: SNotify } => Boolean(entry.peer)),
      notify_defaults: notifyDefaultsToState(localState.loadNotifyDefaults()),
      pinned: [
        { list: PIN_LIST_MAIN, peers: localState.loadPinned().map(peerOf).filter(isPeer) },
        ...pinnedOther,
      ],
    };
  }

  function folderToState(folder: ApiChatFolder): SFolder | undefined {
    if (typeof folder.id !== 'number') return undefined;
    const title = folder.title as ApiChatFolder['title'] | string | undefined;
    return {
      id: folder.id,
      title: typeof title === 'string' ? title : title?.text || '',
      emoticon: folder.emoticon || '',
      include_peers: chatIdsToPeers(folder.includedChatIds),
      exclude_peers: chatIdsToPeers(folder.excludedChatIds),
      pinned_peers: chatIdsToPeers(folder.pinnedChatIds),
      contacts: Boolean(folder.contacts),
      non_contacts: Boolean(folder.nonContacts),
      groups: Boolean(folder.groups),
      channels: Boolean(folder.channels),
      bots: Boolean(folder.bots),
      exclude_muted: Boolean(folder.excludeMuted),
      exclude_read: Boolean(folder.excludeRead),
      exclude_archived: Boolean(folder.excludeArchived),
      color: folder.color ?? NO_COLOR,
    };
  }

  function draftToState(address: string, draft: Record<string, unknown>): SDraft | undefined {
    const peer = peerOf(address);
    const text = (draft as ApiDraft).text;
    if (!peer || !text?.text) return undefined;
    const v2Text = wireToV2({ kind: 'text', text: text.text, entities: apiEntitiesToWire(text.entities) }).text;
    return {
      peer,
      text: bytesToB64(host!.encode('parvane.msg.v2.Text', JSON.stringify(v2Text || {}))),
      date_ms: String(((draft as ApiDraft).date || 0) * MS_IN_SECOND),
    };
  }

  function scheduledToState(entry: JournalScheduled, store: ParvaneStore): SScheduled | undefined {
    const address = store.getAddressForId(entry.chatId);
    const peer = address ? peerOf(address) : undefined;
    if (!peer) return undefined;
    const content = wireToV2({ kind: 'text', text: entry.text || '', entities: apiEntitiesToWire(entry.entities) });
    return {
      op_id: uuidToB64(entry.opId),
      peer,
      send_at_ms: String(entry.scheduledAt * MS_IN_SECOND),
      content: bytesToB64(host!.encode('parvane.msg.v2.Content', JSON.stringify(content))),
    };
  }

  // ── сведённый снимок → localState + нативные апдейты ─────────────────────

  function project() {
    if (!session) return;
    const snap = readSnapshot();
    deps.localState.applyFromJournal(() => {
      projectFolders(snap);
      projectBlocked(snap);
      projectNotify(snap);
      projectArchived(snap);
      projectPinned(snap);
      projectDrafts(snap);
    });
    projectScheduled(snap);
    projectCalls(snap);
    projectCleared(snap);
    void projectInvites(snap)
      .catch((e: unknown) => deps.log(`v2: ссылки-приглашения из журнала состояния: ${String(e)}`));
  }

  function projectFolders(snap: SSnapshot) {
    const { localState } = deps;
    const before = new Map((localState.loadFolders() as unknown as ApiChatFolder[]).map((f) => [f.id, f]));
    const order = snap.folder_order?.ids || [];
    const rank = (id: number) => {
      const index = order.indexOf(id);
      return index < 0 ? order.length + id : index;
    };
    const next = (snap.folders || []).map(stateToFolder).sort((a, b) => rank(a.id) - rank(b.id));
    const beforeIds = Array.from(before.keys());
    const nextIds = next.map(({ id }) => id);
    const isChanged = next.some((f) => JSON.stringify(before.get(f.id)) !== JSON.stringify(f))
      || beforeIds.some((id) => !nextIds.includes(id)) || beforeIds.join() !== nextIds.join();
    if (!isChanged) return;
    localState.saveFolders(next as unknown as { id: number }[]);
    next.forEach((folder) => {
      if (JSON.stringify(before.get(folder.id)) === JSON.stringify(folder)) return;
      deps.sendUpdate({ '@type': 'updateChatFolder', id: folder.id, folder });
    });
    beforeIds.filter((id) => !nextIds.includes(id)).forEach((id) => {
      deps.sendUpdate({ '@type': 'updateChatFolder', id, folder: undefined });
    });
    deps.sendUpdate({ '@type': 'updateChatFoldersOrder', orderedIds: [ALL_CHATS_FOLDER_ID, ...nextIds] });
  }

  function stateToFolder(f: SFolder): ApiChatFolder {
    return {
      id: f.id,
      title: { text: f.title || '' },
      emoticon: f.emoticon || undefined,
      includedChatIds: peersToChatIds(f.include_peers),
      excludedChatIds: peersToChatIds(f.exclude_peers),
      pinnedChatIds: f.pinned_peers?.length ? peersToChatIds(f.pinned_peers) : undefined,
      contacts: f.contacts ? true : undefined,
      nonContacts: f.non_contacts ? true : undefined,
      groups: f.groups ? true : undefined,
      channels: f.channels ? true : undefined,
      bots: f.bots ? true : undefined,
      excludeMuted: f.exclude_muted ? true : undefined,
      excludeRead: f.exclude_read ? true : undefined,
      excludeArchived: f.exclude_archived ? true : undefined,
      color: f.color === undefined || f.color === NO_COLOR ? undefined : f.color,
    };
  }

  // Настройки уведомлений из журнала: исключения по чатам и умолчания по типам
  function projectNotify(snap: SSnapshot) {
    const { localState } = deps;
    const store = deps.getStore();
    const before = localState.loadNotifyExceptions();
    const next: Record<string, LocalNotify> = {};
    (snap.notify || []).forEach((entry) => {
      const address = addressOf(entry.peer);
      if (address) next[address] = notifyFromState(entry.settings, before[address]);
    });
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      localState.saveNotifyExceptions(next);
      new Set([...Object.keys(before), ...Object.keys(next)]).forEach((address) => {
        if (JSON.stringify(before[address]) === JSON.stringify(next[address])) return;
        deps.sendUpdate({
          '@type': 'updateChatNotifySettings',
          chatId: store.getIdForAddress(address, store.isGroupAddress(address) ? 'group' : 'user'),
          settings: next[address] || { mutedUntil: 0 },
        });
      });
    }
    const defaultsBefore = localState.loadNotifyDefaults();
    const defaultsNext: Record<string, LocalNotify> = {};
    NOTIFY_DEFAULT_TYPES.forEach((type) => {
      const settings = snap.notify_defaults?.[type];
      if (settings) defaultsNext[type] = notifyFromState(settings, defaultsBefore[type]);
    });
    if (snap.notify_defaults && JSON.stringify(defaultsBefore) !== JSON.stringify(defaultsNext)) {
      localState.saveNotifyDefaults(defaultsNext);
    }
  }

  function projectBlocked(snap: SSnapshot) {
    const { localState } = deps;
    const store = deps.getStore();
    const before = localState.loadBlocked();
    const next = (snap.blocked || []).map((b) => addressOf(b.peer)).filter(isAddress);
    if (sameSet(before, next)) return;
    localState.saveBlocked(next);
    diffSets(before, next).forEach(({ address, isAdded }) => {
      deps.sendUpdate({ '@type': 'updatePeerBlocked', id: store.getIdForAddress(address), isBlocked: isAdded });
    });
  }

  function projectArchived(snap: SSnapshot) {
    const { localState } = deps;
    const before = localState.loadArchived();
    const next = (snap.archived || []).map(addressOf).filter(isAddress);
    if (sameSet(before, next)) return;
    localState.saveArchivedList(next);
    diffSets(before, next).forEach(({ address, isAdded }) => {
      deps.sendUpdate({
        '@type': 'updateChatListType', id: chatIdOf(address), folderId: isAdded ? ARCHIVED_FOLDER_ID : 0,
      });
    });
  }

  function projectPinned(snap: SSnapshot) {
    const { localState } = deps;
    const before = localState.loadPinned();
    const main = (snap.pinned || []).find((p) => isMainPinList(p.list));
    const next = (main?.peers || []).map(addressOf).filter(isAddress);
    if (before.join('\n') === next.join('\n')) return;
    localState.savePinnedList(next);
    deps.sendUpdate({ '@type': 'updatePinnedChatIds', ids: next.map(chatIdOf) });
  }

  function projectDrafts(snap: SSnapshot) {
    const { localState } = deps;
    const before = localState.loadDrafts();
    const next: Record<string, Record<string, unknown>> = {};
    (snap.drafts || []).forEach((d) => {
      const address = addressOf(d.peer);
      if (!address) return;
      const draft = stateToDraft(d);
      if (draft) next[address] = draft;
    });
    const addresses = new Set([...Object.keys(before), ...Object.keys(next)]);
    const changed = Array.from(addresses).filter((address) => (
      draftText(before[address]) !== draftText(next[address])
    ));
    if (!changed.length) return;
    // Совпадающие по тексту — локальные как есть (дата/ответ этого устройства)
    const merged = { ...next };
    Object.keys(next).forEach((address) => {
      if (!changed.includes(address) && before[address]) merged[address] = before[address];
    });
    localState.replaceDrafts(merged);
    changed.forEach((address) => {
      deps.sendUpdate({
        '@type': 'draftMessage',
        chatId: chatIdOf(address),
        threadId: MAIN_THREAD_ID,
        draft: merged[address],
      });
    });
  }

  function stateToDraft(d: SDraft): Record<string, unknown> | undefined {
    if (!d.text) return undefined;
    const text = decodeText(d.text);
    if (!text?.text) return undefined;
    return { text, date: Math.floor(Number(d.date_ms || 0) / MS_IN_SECOND) };
  }

  function projectScheduled(snap: SSnapshot) {
    const list: JournalScheduled[] = [];
    (snap.scheduled || []).forEach((s) => {
      const address = addressOf(s.peer);
      const opId = b64ToUuid(s.op_id);
      if (!address || !opId || !s.content) return;
      const content = decodeContent(s.content);
      if (!content) return;
      list.push({
        opId,
        chatId: chatIdOf(address),
        scheduledAt: Math.floor(Number(s.send_at_ms || 0) / MS_IN_SECOND),
        text: content.text,
        entities: content.entities,
      });
    });
    deps.localState.applyJournalScheduled(list);
  }

  // ── преобразования ───────────────────────────────────────────────────────

  function decodeText(b64: string): { text: string; entities?: ApiMessageEntity[] } | undefined {
    if (!host) return undefined;
    try {
      const v2Text = JSON.parse(host.decode('parvane.msg.v2.Text', b64ToBytes(b64))) as V2Text;
      const wire = v2ToWire({ text: v2Text });
      if (wire?.kind !== 'text' || !wire.text) return undefined;
      return { text: wire.text, entities: wireEntitiesToApi(wire.entities, wire.text.length) };
    } catch {
      return undefined;
    }
  }

  function decodeContent(b64: string) {
    if (!host) return undefined;
    try {
      const content = JSON.parse(host.decode('parvane.msg.v2.Content', b64ToBytes(b64))) as V2Content;
      const wire = v2ToWire(content);
      if (wire?.kind !== 'text' || !wire.text) return undefined;
      return { text: wire.text, entities: wireEntitiesToApi(wire.entities, wire.text.length) };
    } catch {
      return undefined;
    }
  }

  function peerOf(address: string): SPeer | undefined {
    if (address.includes('@')) return { user: { address } };
    const hex = isV2GroupAddress(address) ? address.slice(V2_GROUP_PREFIX.length) : address.replace(/-/g, '');
    if (!/^[0-9a-f]+$/.test(hex) || hex.length !== UUID_HEX_LENGTH) return undefined;
    return { group: { domain: host!.domain(), id: hexToB64(hex) } };
  }

  // Группа v2 — зарегистрированная `v2g:<hex>`; иначе UUIDv7 группы v1
  function addressOf(peer?: SPeer): string | undefined {
    if (peer?.user?.address) return peer.user.address;
    if (!peer?.group?.id) return undefined;
    const hex = b64ToHex(peer.group.id);
    const v2Address = `${V2_GROUP_PREFIX}${hex}`;
    if (deps.getStore().isGroupAddress(v2Address)) return v2Address;
    const isUuidV7 = hex[12] === '7' && '89ab'.includes(hex[16]);
    return isUuidV7 ? b64ToUuid(peer.group.id) : v2Address;
  }

  function chatIdOf(address: string) {
    return deps.getStore().getIdForAddress(address, address.includes('@') ? 'user' : 'group');
  }

  function chatIdsToPeers(chatIds?: string[]) {
    const store = deps.getStore();
    return (chatIds || []).map((id) => store.getAddressForId(id)).filter(isAddress).map(peerOf).filter(isPeer);
  }

  function peersToChatIds(peers?: SPeer[]) {
    return (peers || []).map(addressOf).filter(isAddress).map(chatIdOf);
  }

  return {
    attach,
    isAttached,
    recordCall,
    recordChatCleared,
    recordGroupInvite,
    removeGroupInvite,
    plannerContainer,
    recordPlannerContainer,
    reset: detach,
    syncNow,
  };
}

// Настройки уведомлений: локальный вид (секунды эпохи, поля tt) ↔ журнал
function notifyToState(settings: LocalNotify): SNotify {
  const mutedUntil = typeof settings.mutedUntil === 'number' ? settings.mutedUntil : 0;
  return {
    mute_until_ms: String(Math.max(0, mutedUntil) * 1000),
    show_previews: typeof settings.shouldShowPreviews === 'boolean' ? settings.shouldShowPreviews : undefined,
    silent: typeof settings.isSilentPosting === 'boolean' ? settings.isSilentPosting : undefined,
  };
}

function notifyFromState(settings: SNotify | undefined, previous: LocalNotify | undefined): LocalNotify {
  const out: LocalNotify = { ...previous, mutedUntil: Math.floor(Number(settings?.mute_until_ms || 0) / 1000) };
  if (typeof settings?.show_previews === 'boolean') out.shouldShowPreviews = settings.show_previews;
  if (typeof settings?.silent === 'boolean') out.isSilentPosting = settings.silent;
  return out;
}

function notifyDefaultsToState(defaults: Record<string, LocalNotify>) {
  const out: NonNullable<SSnapshot['notify_defaults']> = {};
  NOTIFY_DEFAULT_TYPES.forEach((type) => {
    if (defaults[type]) out[type] = notifyToState(defaults[type]);
  });
  return out;
}

function isPeer(peer: SPeer | undefined): peer is SPeer {
  return Boolean(peer);
}

function isAddress(address: string | undefined): address is string {
  return Boolean(address);
}

function isMainPinList(list: SPinned['list']) {
  return list === PIN_LIST_MAIN || list === PIN_LIST_MAIN_NUMBER;
}

function peerKey(peer?: SPeer) {
  return peer?.user ? `u:${peer.user.address}` : `g:${peer?.group?.domain}:${peer?.group?.id}`;
}

function draftText(draft?: Record<string, unknown>) {
  const text = (draft as ApiDraft | undefined)?.text;
  return text?.text ? `${text.text}\u0000${JSON.stringify(text.entities || [])}` : '';
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function diffSets(before: string[], next: string[]) {
  return [
    ...next.filter((x) => !before.includes(x)).map((address) => ({ address, isAdded: true })),
    ...before.filter((x) => !next.includes(x)).map((address) => ({ address, isAdded: false })),
  ];
}

function bytesToB64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

function b64ToBytes(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function inviteToState(address: string, record: V2SharedInvite['record']): SInvite {
  return {
    group_id: hexToB64(address.slice(V2_GROUP_PREFIX.length)),
    link_id: hexToB64(record.linkId),
    url: record.url,
    created_ms: String(record.date * MS_IN_SECOND),
    title: record.title,
    expires_ms: record.expiresAt ? String(record.expiresAt * MS_IN_SECOND) : undefined,
    usage_limit: record.usageLimit,
    requires_approval: record.isRequestNeeded,
  };
}

function inviteFromState(invite: SInvite): V2SharedInvite | undefined {
  if (!invite.group_id || !invite.link_id || !invite.url) return undefined;
  return {
    address: `${V2_GROUP_PREFIX}${b64ToHex(invite.group_id)}`,
    record: {
      url: invite.url,
      linkId: b64ToHex(invite.link_id),
      date: Math.floor(Number(invite.created_ms || 0) / MS_IN_SECOND),
      title: invite.title || undefined,
      expiresAt: Number(invite.expires_ms || 0) ? Math.floor(Number(invite.expires_ms) / MS_IN_SECOND) : undefined,
      usageLimit: invite.usage_limit || undefined,
      isRequestNeeded: invite.requires_approval || undefined,
    },
  };
}

function hexToB64(hex: string) {
  return btoa(String.fromCharCode(...(hex.match(/../g) || []).map((h) => parseInt(h, 16))));
}

function b64ToHex(b64: string) {
  return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
