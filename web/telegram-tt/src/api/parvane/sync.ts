import type { ApiMessage, ApiUpdate, ApiVideo } from '../types';
import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { PollStore } from './polls';

import { buildWebPage, type ParvaneStore } from './store';
import {
  buildWireEvent,
  TOPIC_GROUP_LIST,
  TOPIC_IDENTITY_RESOLVE,
  TOPIC_MSG_ACK,
  TOPIC_MSG_SYNC_REQUEST,
  type WireEvent,
  type WireGroupInfo,
  type WireMessageContent,
  type WireStoredMessage,
  type WireUserInfo,
} from './wire';

type SyncDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  groups: {
    register: (info: WireGroupInfo) => void;
    refreshMemberships: () => Promise<void>;
  };
  localState: {
    readOwnJournal: () => WireStoredMessage[];
    scheduleTtlDeletion: (chatId: string, messageId: number, ttlSecs: number) => void;
  };
  media: { rememberKeys: (content: WireMessageContent) => void };
  polls: PollStore;
  refreshPollMessage: (uuid: string) => void;
  rememberSavedGif: (gif: ApiVideo) => void;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
};

type WireFlags = { read: boolean; deleted: boolean; pinned: boolean; snapshot: string };
type UnsealResult = { stored: WireStoredMessage; wasSealed: boolean; hidden?: boolean };

const SYNC_TIMEOUT_MS = 15000;

export function createSyncController(deps: SyncDependencies) {
  let isSynced = false;
  let syncPromise: Promise<void> | undefined;
  let deltaSyncPromise: Promise<void> | undefined;
  let lastSeenUuid = '';
  let sinceUpdated = 0;
  const wireFlagsByUuid = new Map<string, WireFlags>();
  const readOutboxMaxByChatId = new Map<string, number>();
  const reportedReadUuids = new Set<string>();
  const checkedGroupCandidates = new Set<string>();

  function buildSyncPayload(lastSeenId: string, updatedSince: number) {
    const e2e = deps.getE2e();
    return {
      last_seen_id: lastSeenId,
      since_updated: updatedSince,
      sender_signing_key: e2e?.signingKey,
      signature: e2e?.signCallData(`sync:${lastSeenId}:${updatedSince}`),
    };
  }

  const buildWireFlags = (stored: WireStoredMessage): WireFlags => ({
    read: Boolean(stored.read),
    deleted: Boolean(stored.deleted),
    pinned: Boolean(stored.pinned),
    snapshot: JSON.stringify([stored.content, stored.reactions, stored.pinned, stored.edited]),
  });

  function reset() {
    isSynced = false;
    syncPromise = undefined;
    deltaSyncPromise = undefined;
    lastSeenUuid = '';
    sinceUpdated = 0;
    wireFlagsByUuid.clear();
    readOutboxMaxByChatId.clear();
    reportedReadUuids.clear();
    checkedGroupCandidates.clear();
  }

  function resetPromise() {
    syncPromise = undefined;
    deltaSyncPromise = undefined;
  }

  function trackCursors(stored: WireStoredMessage) {
    if (stored.id > lastSeenUuid) lastSeenUuid = stored.id;
    const updatedAt = stored.updated_at || 0;
    if (updatedAt > sinceUpdated) sinceUpdated = updatedAt;
  }

  function unsealStored(stored: WireStoredMessage): UnsealResult {
    const content = stored.content;
    const e2e = deps.getE2e();
    const store = deps.getStore();
    const cached = e2e?.getCachedInner(stored.id);

    // A sealed tombstone intentionally has no ciphertext or public sender.
    // Reuse the UUID binding established when the original message was
    // decrypted so the delete update targets the correct private chat.
    if (stored.deleted && cached) {
      return {
        stored: { ...stored, from: cached.from, content: cached.content as WireMessageContent },
        wasSealed: true,
      };
    }

    if (content.kind === 'group_encrypted') {
      if (cached && (!stored.edited || cached.from === store.self)) {
        deps.media.rememberKeys(cached.content as WireMessageContent);
        return { stored: { ...stored, content: cached.content as WireMessageContent }, wasSealed: true };
      }
      if (!e2e || !content.ciphertext || !content.group || !content.sender_identity) {
        return { stored, wasSealed: false };
      }
      const plain = e2e.groupDecrypt(content.group, content.sender_identity, content.ciphertext);
      if (!plain) return { stored, wasSealed: false };
      try {
        const inner = JSON.parse(plain) as WireMessageContent;
        e2e.cacheInner(stored.id, { from: stored.from, content: inner });
        deps.media.rememberKeys(inner);
        return { stored: { ...stored, content: inner }, wasSealed: true };
      } catch {
        return { stored, wasSealed: false };
      }
    }

    if (content.kind !== 'encrypted') return { stored, wasSealed: false };
    if (cached && (!stored.edited || cached.from === store.self)) {
      deps.media.rememberKeys(cached.content as WireMessageContent);
      return {
        stored: { ...stored, from: cached.from, content: cached.content as WireMessageContent },
        wasSealed: true,
      };
    }
    if (!e2e || !content.ciphertext || !content.sender_identity) return { stored, wasSealed: false };

    const plain = e2e.decryptFrom(content.sender_identity, content.ctype || 0, content.ciphertext);
    if (!plain) return { stored, wasSealed: false };
    try {
      const inner = JSON.parse(plain) as { from: string; content: WireMessageContent };
      if (inner.from) e2e.rememberContactIdentity(inner.from, content.sender_identity);
      if (inner.content?.kind === 'skdm' && inner.content.group && inner.content.session_key) {
        e2e.acceptGroupKey(
          inner.content.group,
          inner.content.sender_identity!,
          inner.content.session_key,
          inner.content.epoch || 0,
        );
        return { stored, wasSealed: true, hidden: true };
      }
      e2e.cacheInner(stored.id, inner);
      deps.media.rememberKeys(inner.content);
      return { stored: { ...stored, from: inner.from, content: inner.content }, wasSealed: true };
    } catch {
      return { stored, wasSealed: false };
    }
  }

  function handlePollContent(stored: WireStoredMessage) {
    const content = stored.content;
    const store = deps.getStore();
    if (content.kind === 'poll') {
      const chatAddress = store.isGroupAddress(stored.to) ? stored.to
        : (stored.from && stored.from !== store.self ? stored.from : stored.to);
      const chatId = store.getIdForAddress(
        chatAddress,
        store.isGroupAddress(chatAddress) ? 'group' : 'user',
      );
      deps.polls.register(
        stored.id,
        chatId,
        (content as { question?: string }).question || '',
        (content as { options?: string[] }).options || [],
        {
          isPublic: Boolean((content as { is_public?: boolean }).is_public),
          isMultiple: Boolean((content as { is_multiple?: boolean }).is_multiple),
        },
      );
      return false;
    }
    if (content.kind === 'poll_vote') {
      const pollUuid = (content as { poll?: string }).poll;
      const options = (content as { options?: number[] }).options || [];
      if (pollUuid && stored.from) {
        deps.polls.applyVote(pollUuid, stored.from, options);
        deps.refreshPollMessage(pollUuid);
      }
      return true;
    }
    if (content.kind === 'poll_close') {
      const pollUuid = (content as { poll?: string }).poll;
      if (pollUuid) {
        deps.polls.close(pollUuid);
        deps.refreshPollMessage(pollUuid);
      }
      return true;
    }
    return false;
  }

  async function resolveDisplayNames(addresses: string[]) {
    if (!addresses.length) return;
    try {
      const raw = await deps.getConnection()!.request(
        TOPIC_IDENTITY_RESOLVE,
        JSON.stringify({ usernames: addresses }),
      );
      const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
      const store = deps.getStore();
      users.forEach((userInfo) => {
        store.setDisplayName(userInfo.username, userInfo.display_name || userInfo.username);
        const previousAvatar = store.getAvatar(userInfo.username);
        store.setAvatar(userInfo.username, userInfo.avatar);
        if (userInfo.avatar !== previousAvatar && userInfo.username !== store.self) {
          const user = store.buildApiUser(userInfo.username);
          deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
        }
      });
    } catch {
      // Имена не критичны — показываем локальную часть адреса.
    }
  }

  function announcePeer(address: string) {
    const store = deps.getStore();
    if (store.isGroupAddress(address)) return;
    const user = store.buildApiUser(address);
    deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
    deps.sendUpdate({ '@type': 'updateChat', id: user.id, chat: store.buildApiChatForUser(address) });
    void resolveDisplayNames([address]);
  }

  function sendAck(messageId: string, sealedSender: string) {
    const store = deps.getStore();
    const ack = buildWireEvent(store.self, deps.getToken(), { message_id: messageId, sender: sealedSender });
    try {
      deps.getConnection()?.publish(TOPIC_MSG_ACK, JSON.stringify(ack));
    } catch {
      // Без ACK сервер повторит доставку; UUID-дедупликация погасит повтор.
    }
  }

  async function refreshGroupsIfUnknownChat(stored: WireStoredMessage) {
    const store = deps.getStore();
    if (!stored.to || stored.to === store.self || stored.from === store.self
      || store.isGroupAddress(stored.to) || checkedGroupCandidates.has(stored.to)) {
      return;
    }
    checkedGroupCandidates.add(stored.to);
    try {
      const raw = await deps.getConnection()!.request(
        TOPIC_GROUP_LIST,
        JSON.stringify({ token: deps.getToken() }),
      );
      const groups = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups || [];
      groups.forEach((info) => {
        const isNew = !store.isGroupAddress(info.group_id);
        deps.groups.register(info);
        if (isNew) {
          const chat = store.buildApiChatForGroup(info);
          deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
        }
      });
    } catch {
      // Список групп догоним следующим синком.
    }
  }

  function noteReadOutbox(message: ApiMessage) {
    const current = readOutboxMaxByChatId.get(message.chatId) || 0;
    if (message.id <= current) return;
    readOutboxMaxByChatId.set(message.chatId, message.id);
    deps.sendUpdate({
      '@type': 'updateChat',
      id: message.chatId,
      chat: {},
      readState: { lastReadOutboxMessageId: message.id },
    });
  }

  async function applyStoredUpdate(rawStored: WireStoredMessage, shouldAckIncoming: boolean) {
    trackCursors(rawStored);
    const { stored, wasSealed, hidden } = unsealStored(rawStored);
    const store = deps.getStore();
    if (hidden) {
      if (shouldAckIncoming) sendAck(rawStored.id, stored.from);
      return;
    }
    await refreshGroupsIfUnknownChat(stored);
    if (handlePollContent(stored)) {
      if (shouldAckIncoming && stored.from !== store.self) {
        sendAck(rawStored.id, wasSealed ? stored.from : '');
      }
      return;
    }
    deps.media.rememberKeys(stored.content);
    const previousFlags = wireFlagsByUuid.get(stored.id);
    const flags = buildWireFlags(stored);
    wireFlagsByUuid.set(stored.id, flags);

    const isKnown = store.hasMessage(stored.id);
    const message = store.buildApiMessage(stored);
    store.putMessage(message);
    if (stored.content.kind === 'gif' && message.content.video) deps.rememberSavedGif(message.content.video);
    if (!message.isOutgoing && shouldAckIncoming) sendAck(stored.id, wasSealed ? stored.from : '');

    if (!isKnown) {
      if (!message.isOutgoing && stored.from) announcePeer(stored.from);
      const webPage = buildWebPage(stored);
      deps.sendUpdate({
        '@type': 'newMessage',
        chatId: message.chatId,
        id: message.id,
        message,
        webPages: webPage ? [webPage] : undefined,
        poll: stored.content.kind === 'poll' ? deps.polls.build(stored.id) : undefined,
      });
      if (flags.read && message.isOutgoing) noteReadOutbox(message);
      if (stored.content.ttl_secs) {
        deps.localState.scheduleTtlDeletion(message.chatId, message.id, stored.content.ttl_secs);
      }
      return;
    }

    if (flags.deleted && !previousFlags?.deleted) {
      deps.sendUpdate({ '@type': 'deleteMessages', ids: [message.id], chatId: message.chatId });
      return;
    }
    if ((!previousFlags || flags.snapshot !== previousFlags.snapshot) && !flags.deleted) {
      deps.sendUpdate({
        '@type': 'updateMessage', chatId: message.chatId, id: message.id, isFull: true, message,
      });
    }
    if (previousFlags && flags.pinned !== previousFlags.pinned) {
      deps.sendUpdate({
        '@type': 'updatePinnedIds', chatId: message.chatId, isPinned: flags.pinned, messageIds: [message.id],
      });
    }
    if (flags.read && !previousFlags?.read && message.isOutgoing) noteReadOutbox(message);
  }

  async function runFullSync() {
    const store = deps.getStore();
    const connection = deps.getConnection()!;
    const token = deps.getToken();
    const groupsRaw = await connection.request(TOPIC_GROUP_LIST, JSON.stringify({ token }));
    const groups = (JSON.parse(groupsRaw) as { groups?: WireGroupInfo[] }).groups || [];
    groups.forEach(deps.groups.register);

    const syncEvent = buildWireEvent(store.self, token, buildSyncPayload('0', 0));
    const syncRaw = await connection.request(
      TOPIC_MSG_SYNC_REQUEST,
      JSON.stringify(syncEvent),
      SYNC_TIMEOUT_MS,
    );
    const parsed = JSON.parse(syncRaw) as WireEvent<{ messages?: WireStoredMessage[] }>;
    const serverMessages = parsed.payload?.messages || [];
    serverMessages.forEach(trackCursors);
    const knownIds = new Set(serverMessages.map((message) => message.id));
    const journal = deps.localState.readOwnJournal().filter((message) => !knownIds.has(message.id));
    const ordered = serverMessages.concat(journal)
      .sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1));

    ordered.forEach((stored) => {
      if (stored.content.kind === 'encrypted') unsealStored(stored);
    });
    ordered.forEach((rawStored) => {
      const { stored, hidden } = unsealStored(rawStored);
      if (hidden || handlePollContent(stored)) return;
      deps.media.rememberKeys(stored.content);
      wireFlagsByUuid.set(stored.id, buildWireFlags(stored));
      const message = store.buildApiMessage(stored);
      store.putMessage(message);
      if (message.isOutgoing && stored.read) {
        const current = readOutboxMaxByChatId.get(message.chatId) || 0;
        if (message.id > current) readOutboxMaxByChatId.set(message.chatId, message.id);
      }
      if (!message.isOutgoing && stored.read) reportedReadUuids.add(stored.id);
      if (stored.content.ttl_secs) {
        const remaining = stored.content.ttl_secs - (Math.floor(Date.now() / 1000) - stored.ts);
        deps.localState.scheduleTtlDeletion(message.chatId, message.id, Math.max(0, remaining));
      }
    });

    const peerAddresses = new Set<string>();
    serverMessages.concat(journal).forEach((message) => {
      if (message.from && !store.isGroupAddress(message.from)) peerAddresses.add(message.from);
      if (message.to && !store.isGroupAddress(message.to)) peerAddresses.add(message.to);
    });
    groups.forEach((group) => group.members.forEach(({ address }) => peerAddresses.add(address)));
    peerAddresses.delete(store.self);
    await resolveDisplayNames(Array.from(peerAddresses));
    isSynced = true;
  }

  function ensureSynced() {
    if (isSynced) return Promise.resolve();
    if (!syncPromise) {
      syncPromise = runFullSync().catch((error) => {
        syncPromise = undefined;
        throw error;
      });
    }
    return syncPromise;
  }

  async function runDeltaSync() {
    const connection = deps.getConnection();
    if (!connection || !isSynced) return;
    await deps.groups.refreshMemberships();
    let messages: WireStoredMessage[];
    try {
      const store = deps.getStore();
      const syncEvent = buildWireEvent(
        store.self,
        deps.getToken(),
        buildSyncPayload(lastSeenUuid || '0', sinceUpdated),
      );
      const raw = await connection.request(
        TOPIC_MSG_SYNC_REQUEST,
        JSON.stringify(syncEvent),
        SYNC_TIMEOUT_MS,
      );
      const parsed = JSON.parse(raw) as WireEvent<{ messages?: WireStoredMessage[] }>;
      messages = parsed.payload?.messages || [];
    } catch {
      return;
    }
    const sorted = messages.sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1));
    for (const stored of sorted) await applyStoredUpdate(stored, true);
  }

  function requestDeltaSync() {
    if (deltaSyncPromise) return;
    deltaSyncPromise = runDeltaSync()
      .catch((error) => deps.log(`дельта-синк не выполнен: ${String(error)}`))
      .finally(() => {
        deltaSyncPromise = undefined;
      });
  }

  function handleInboxFrame(payload: string) {
    let event: WireEvent<{ message?: WireStoredMessage; message_id?: string }>;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const stored = event.payload?.message;
    if (!stored) return;
    void applyStoredUpdate(stored, true).catch((error) => {
      deps.log(`входящее сообщение не применено: ${String(error)}`);
    });
  }

  return {
    announcePeer,
    ensureSynced,
    getFlags: (uuid: string) => wireFlagsByUuid.get(uuid),
    getReadOutboxMax: (chatId: string) => readOutboxMaxByChatId.get(chatId),
    handleInboxFrame,
    hasReportedRead: (uuid: string) => reportedReadUuids.has(uuid),
    isSynced: () => isSynced,
    markDeleted: (uuid: string) => {
      const flags = wireFlagsByUuid.get(uuid);
      if (flags) flags.deleted = true;
    },
    markReportedRead: (uuid: string) => reportedReadUuids.add(uuid),
    requestDeltaSync,
    reset,
    resetPromise,
    resolveDisplayNames,
  };
}
