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
type SSnapshot = {
  folders?: SFolder[];
  folder_order?: { ids?: number[] };
  blocked?: { peer?: SPeer; blocked_at_ms?: string }[];
  drafts?: SDraft[];
  scheduled?: SScheduled[];
  scheduled_sent?: string[];
  archived?: SPeer[];
  pinned?: SPinned[];
  [key: string]: unknown;
};

const MANAGED_KINDS: LocalStateKind[] = ['folders', 'blocked', 'drafts', 'scheduled', 'archived', 'pinned'];
const PIN_LIST_MAIN = 'PIN_LIST_MAIN';
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

  function markMigrated() {
    try {
      localStorage.setItem(migratedKey(), '1');
    } catch {
      // приватный режим — повторная миграция сходится (union по LWW)
    }
  }

  async function attach(nextHost: StateJournalHost) {
    detach();
    const nextSession = nextHost.openSession();
    if (!nextSession) {
      deps.log('v2: журнал состояния недоступен — нет ключа личного состояния');
      return;
    }
    host = nextHost;
    session = nextSession;
    await serial(async () => {
      await pullRemote();
      if (!isMigrated()) {
        // Первый запуск на v2: локальные данные — начальными записями журнала
        const bodies = session!.migrate(JSON.stringify(buildDesired({})));
        pendingAppends.push(...bodies);
        await pushAppends();
        markMigrated();
        deps.log(`v2: локальное состояние перенесено в журнал (${bodies.length} записей)`);
      }
      project();
    }).catch((e: unknown) => deps.log(`v2: журнал состояния не прочитан: ${String(e)}`));
    deps.localState.setChangeListener(scheduleFlush);
    deps.localState.setScheduledHooks({ gate: canSendScheduled, sent: markScheduledSent });
    syncTimer = setInterval(() => {
      void syncNow().catch((e: unknown) => deps.log(`v2: синк журнала состояния: ${String(e)}`));
    }, SYNC_INTERVAL_MS);
    deps.log('v2: журнал состояния подключён');
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
    const current = readSnapshot();
    const bodies = session.diff(JSON.stringify(buildDesired(current)), MANAGED_KINDS);
    pendingAppends.push(...bodies);
    await pushAppends();
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
      projectArchived(snap);
      projectPinned(snap);
      projectDrafts(snap);
    });
    projectScheduled(snap);
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
    reset: detach,
    syncNow,
  };
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

function hexToB64(hex: string) {
  return btoa(String.fromCharCode(...(hex.match(/../g) || []).map((h) => parseInt(h, 16))));
}

function b64ToHex(b64: string) {
  return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
