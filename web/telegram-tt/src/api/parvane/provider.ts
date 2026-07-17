// Провайдер Parvane: тот же интерфейс, что у `gramjs/worker/connector`
// (initApi/callApi + поток ApiUpdate), но вместо MTProto — шина Parvane через
// gateway (WebSocket, JSON-кадры). Работает в главном потоке, без воркера.

import type {
  ApiInitialArgs,
  ApiMessage,
  ApiOnProgress,
  ApiThreadInfo,
  ApiUpdate,
  ApiUser,
  ApiUserStatus,
  OnApiUpdate,
} from '../types';
import { MAIN_THREAD_ID } from '../types';
import type { MethodArgs, MethodResponse, Methods } from '../gramjs/methods/types';
import type { SendMessageParams, ThreadReadState } from '../../types';
import type { ApiChat } from '../types';
import type {
  WireEvent, WireGroupInfo, WireStoredMessage, WireUserInfo,
} from './wire';

import { GatewayConnection, getGatewayUrl } from './gateway';
import { buildOldLangPack } from './oldLangPack';
import { ParvaneStore } from './store';
import {
  buildMsgInboxTopic,
  buildWireEvent,
  TOPIC_GROUP_LIST,
  TOPIC_IDENTITY_ISSUE,
  TOPIC_IDENTITY_REGISTER,
  TOPIC_IDENTITY_RESOLVE,
  TOPIC_IDENTITY_SEARCH,
  TOPIC_MSG_ACK,
  TOPIC_MSG_DELETE,
  TOPIC_MSG_EDIT,
  TOPIC_MSG_PIN,
  TOPIC_MSG_REACT,
  TOPIC_MSG_READ,
  TOPIC_MSG_SEND,
  TOPIC_MSG_SYNC_REQUEST,
} from './wire';

const CREDS_STORAGE_KEY = 'parvane:creds';
const LOGIN_HASH_PREFIX = '#parvane=';
const SYNC_TIMEOUT_MS = 15000;
const DELTA_SYNC_INTERVAL_MS = 10000;
const PRESENCE_INTERVAL_MS = 30000;
const PRESENCE_TTL_SECS = 90;
const TYPING_CLEAR_MS = 6000;

let onUpdate: OnApiUpdate = () => undefined;
let connection: GatewayConnection | undefined;
let store = new ParvaneStore();
let token = '';
let pendingLoginAddress = '';
let isSynced = false;
let syncPromise: Promise<void> | undefined;
let syncTimer: number | undefined;
let presenceTimer: number | undefined;
const typingClearTimers = new Map<string, number>();
// Курсоры дельта-синка (аналог PumpReceive в десктоп-форке): uuid v7
// лексикографически упорядочен по времени, поэтому max-строка = новейший
let lastSeenUuid = '';
let sinceUpdated = 0;
const uuidBySentLocalKey = new Map<string, string>();
const reportedMissingMethods = new Set<string>();
// Снапшот состояния по uuid — чтобы дельта-синк видел, что изменилось
type WireFlags = { read: boolean; deleted: boolean; pinned: boolean; snapshot: string };
const wireFlagsByUuid = new Map<string, WireFlags>();

function buildWireFlags(stored: WireStoredMessage): WireFlags {
  return {
    read: Boolean(stored.read),
    deleted: Boolean(stored.deleted),
    pinned: Boolean(stored.pinned),
    snapshot: JSON.stringify([stored.content, stored.reactions, stored.pinned, stored.edited]),
  };
}
// Максимальный прочитанный собеседником id исходящего по чату (для ✓✓)
const readOutboxMaxByChatId = new Map<string, number>();
// Уже отправленные read-квитанции (не спамить повторно)
const reportedReadUuids = new Set<string>();

export async function initApi(_onUpdate: OnApiUpdate, _initialArgs: ApiInitialArgs) {
  onUpdate = _onUpdate;
  // eslint-disable-next-line no-console
  console.info('[parvane] initApi вызван');

  sendUpdate({ '@type': 'updateApiReady' });
  sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });

  const creds = readCreds();
  if (!creds) {
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
    return;
  }

  try {
    await connectAndLogin(creds.user, creds.password);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[parvane] логин не удался:', err);
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
    sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
  }
}

async function connectAndLogin(user: string, password: string) {
  connection?.close();
  connection = new GatewayConnection();
  await connection.connect(getGatewayUrl());
  logDebug('WS открыт');

  token = await issueToken(user, password);
  logDebug('JWT получен');
  await connection.authorize(token);
  logDebug(`авторизован: ${user}`);

  store = new ParvaneStore();
  store.self = user;
  isSynced = false;
  syncPromise = undefined;
  lastSeenUuid = '';
  sinceUpdated = 0;
  wireFlagsByUuid.clear();
  readOutboxMaxByChatId.clear();
  reportedReadUuids.clear();

  connection.subscribe(buildMsgInboxTopic(user), handleInboxFrame);
  connection.subscribe(`msg.typing.${selfId()}`, handleTypingFrame);
  connection.subscribe('presence.*', handlePresenceFrame);
  connection.onClose = () => {
    sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
  };

  await resolveDisplayNames([user]);
  logDebug('имена получены, шлю ready-апдейты');

  const currentUser = store.buildApiUser(user);
  sendUpdate({ '@type': 'updateCurrentUser', currentUser, currentUserFullInfo: {} });
  sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateReady' });
  sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' });

  window.clearInterval(syncTimer);
  syncTimer = window.setInterval(() => { void runDeltaSync(); }, DELTA_SYNC_INTERVAL_MS);
  window.clearInterval(presenceTimer);
  presenceTimer = window.setInterval(publishPresence, PRESENCE_INTERVAL_MS);
  publishPresence();
}

function publishPresence() {
  if (!connection) return;
  connection.publish(`presence.${selfId()}`, JSON.stringify({ from: store.self }));
}

function handleTypingFrame(payload: string) {
  let from: string | undefined;
  try {
    from = (JSON.parse(payload) as { from?: string }).from;
  } catch {
    return;
  }
  if (!from || from === store.self) return;

  const chatId = store.getIdForAddress(from);
  sendUpdate({
    '@type': 'updateChatTypingStatus',
    id: chatId,
    peerId: chatId,
    typingStatus: { type: 'typing', timestamp: Math.floor(Date.now() / 1000) },
  });

  // Собеседник шлёт хартбиты пока печатает; без свежего — гасим сами
  window.clearTimeout(typingClearTimers.get(chatId));
  typingClearTimers.set(chatId, window.setTimeout(() => {
    sendUpdate({
      '@type': 'updateChatTypingStatus', id: chatId, peerId: chatId, typingStatus: undefined,
    });
  }, TYPING_CLEAR_MS));
}

function handlePresenceFrame(payload: string) {
  let from: string | undefined;
  try {
    from = (JSON.parse(payload) as { from?: string }).from;
  } catch {
    return;
  }
  if (!from || from === store.self) return;

  sendUpdate({
    '@type': 'updateUserStatus',
    userId: store.getIdForAddress(from),
    status: { type: 'userStatusOnline', expires: Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECS },
  });
}

function logDebug(message: string) {
  // eslint-disable-next-line no-console
  console.info(`[parvane] ${message}`);
}

async function issueToken(user: string, password: string) {
  const issue = async () => {
    const raw = await connection!.request(TOPIC_IDENTITY_ISSUE, JSON.stringify({ user, password }));
    return JSON.parse(raw) as { ok: boolean; token?: string; error?: string };
  };

  let resp = await issue();
  if (!resp.ok) {
    // Новый пользователь — регистрируем и повторяем логин (как в десктоп-форке)
    const regRaw = await connection!.request(
      TOPIC_IDENTITY_REGISTER, JSON.stringify({ user, password, invite: '' }),
    );
    const reg = JSON.parse(regRaw) as { ok: boolean; error?: string };
    if (reg.ok) resp = await issue();
  }
  if (!resp.ok || !resp.token) {
    throw new Error(resp.error || 'identity отказал в выдаче токена');
  }
  return resp.token;
}

// ── синк ──────────────────────────────────────────────────────────────────────

function ensureSynced() {
  if (isSynced) return Promise.resolve();
  if (!syncPromise) syncPromise = runFullSync();
  return syncPromise;
}

async function runFullSync() {
  const groupsRaw = await connection!.request(TOPIC_GROUP_LIST, JSON.stringify({ token }));
  const groups = (JSON.parse(groupsRaw) as { groups?: WireGroupInfo[] }).groups || [];
  groups.forEach((info) => store.registerGroup(info));

  const syncEvent = buildWireEvent(store.self, token, { last_seen_id: '0', since_updated: 0 });
  const syncRaw = await connection!.request(
    TOPIC_MSG_SYNC_REQUEST, JSON.stringify(syncEvent), SYNC_TIMEOUT_MS,
  );
  const parsed = JSON.parse(syncRaw) as WireEvent<{ messages?: WireStoredMessage[] }>;
  const messages = parsed.payload?.messages || [];

  messages
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    .forEach((stored) => {
      trackCursors(stored);
      wireFlagsByUuid.set(stored.id, buildWireFlags(stored));
      const message = store.buildApiMessage(stored);
      store.putMessage(message);
      if (message.isOutgoing && stored.read) {
        const current = readOutboxMaxByChatId.get(message.chatId) || 0;
        if (message.id > current) readOutboxMaxByChatId.set(message.chatId, message.id);
      }
      if (!message.isOutgoing && stored.read) {
        reportedReadUuids.add(stored.id);
      }
    });

  const peerAddresses = new Set<string>();
  messages.forEach((m) => {
    if (m.from && !store.isGroupAddress(m.from)) peerAddresses.add(m.from);
    if (m.to && !store.isGroupAddress(m.to)) peerAddresses.add(m.to);
  });
  groups.forEach((g) => g.members.forEach(({ address }) => peerAddresses.add(address)));
  peerAddresses.delete(store.self);

  await resolveDisplayNames(Array.from(peerAddresses));
  isSynced = true;
}

async function resolveDisplayNames(addresses: string[]) {
  if (!addresses.length) return;
  try {
    const raw = await connection!.request(TOPIC_IDENTITY_RESOLVE, JSON.stringify({ usernames: addresses }));
    const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
    users.forEach((u) => store.setDisplayName(u.username, u.display_name || u.username));
  } catch {
    // Имена не критичны — покажем локальную часть адреса
  }
}

// ── приём (персональный инбокс) ──────────────────────────────────────────────

function handleInboxFrame(payload: string) {
  let event: WireEvent<{ message?: WireStoredMessage; message_id?: string }>;
  try {
    event = JSON.parse(payload);
  } catch {
    return;
  }

  const stored = event.payload?.message;
  if (!stored) return; // delivered-квитанция; у Telegram нет отдельного статуса

  applyStoredUpdate(stored, true);
}

// Общий приёмник состояния сообщения — и для инбокс-пуша, и для дельта-синка.
// Новое → newMessage; мутации known → deleteMessages / updateMessage / ✓✓.
function applyStoredUpdate(stored: WireStoredMessage, shouldAckIncoming: boolean) {
  trackCursors(stored);
  const prevFlags = wireFlagsByUuid.get(stored.id);
  const flags = buildWireFlags(stored);
  wireFlagsByUuid.set(stored.id, flags);

  const isKnown = store.hasMessage(stored.id);
  const message = store.buildApiMessage(stored);
  store.putMessage(message);

  if (!message.isOutgoing && shouldAckIncoming) {
    sendAck(stored);
  }

  if (!isKnown) {
    if (!message.isOutgoing && stored.from) {
      announcePeer(stored.from);
    }
    sendUpdate({
      '@type': 'newMessage',
      chatId: message.chatId,
      id: message.id,
      message,
    });
    if (flags.read && message.isOutgoing) noteReadOutbox(message);
    return;
  }

  if (flags.deleted && !prevFlags?.deleted) {
    sendUpdate({ '@type': 'deleteMessages', ids: [message.id], chatId: message.chatId });
    return;
  }
  if (prevFlags && flags.snapshot !== prevFlags.snapshot && !flags.deleted) {
    sendUpdate({
      '@type': 'updateMessage', chatId: message.chatId, id: message.id, isFull: true, message,
    });
  }
  if (prevFlags && flags.pinned !== prevFlags.pinned) {
    sendUpdate({
      '@type': 'updatePinnedIds', chatId: message.chatId, isPinned: flags.pinned, messageIds: [message.id],
    });
  }
  if (flags.read && !prevFlags?.read && message.isOutgoing) {
    noteReadOutbox(message);
  }
}

function noteReadOutbox(message: ApiMessage) {
  const current = readOutboxMaxByChatId.get(message.chatId) || 0;
  if (message.id <= current) return;
  readOutboxMaxByChatId.set(message.chatId, message.id);
  sendUpdate({
    '@type': 'updateChat',
    id: message.chatId,
    chat: {},
    readState: { lastReadOutboxMessageId: message.id },
  });
}

function trackCursors(stored: WireStoredMessage) {
  if (stored.id > lastSeenUuid) lastSeenUuid = stored.id;
  const updatedAt = stored.updated_at || 0;
  if (updatedAt > sinceUpdated) sinceUpdated = updatedAt;
}

async function runDeltaSync() {
  if (!connection || !isSynced) return;
  let messages: WireStoredMessage[];
  try {
    const syncEvent = buildWireEvent(store.self, token, {
      last_seen_id: lastSeenUuid || '0',
      since_updated: sinceUpdated,
    });
    const raw = await connection.request(TOPIC_MSG_SYNC_REQUEST, JSON.stringify(syncEvent), SYNC_TIMEOUT_MS);
    const parsed = JSON.parse(raw) as WireEvent<{ messages?: WireStoredMessage[] }>;
    messages = parsed.payload?.messages || [];
  } catch {
    return; // сеть моргнула — догоним в следующий тик
  }
  messages
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    .forEach((stored) => applyStoredUpdate(stored, true));
}

function announcePeer(address: string) {
  if (store.isGroupAddress(address)) return;
  const user = store.buildApiUser(address);
  sendUpdate({ '@type': 'updateUser', id: user.id, user });
  sendUpdate({ '@type': 'updateChat', id: user.id, chat: store.buildApiChatForUser(address) });
  void resolveDisplayNames([address]);
}

function sendAck(stored: WireStoredMessage) {
  const ack = buildWireEvent(store.self, token, { message_id: stored.id, sender: '' });
  connection!.publish(TOPIC_MSG_ACK, JSON.stringify(ack));
}

// ── методы (подмножество Methods, остальное — заглушки) ──────────────────────

const RECENT_STATUS: ApiUserStatus = { type: 'userStatusRecently' };

const methods = {
  async fetchChats({ archived }: { archived?: boolean }) {
    if (archived) {
      // Архива у Parvane пока нет
      return {
        chatIds: [],
        chats: [],
        users: [],
        userStatusesById: {},
        draftsById: {},
        threadReadStatesById: {},
        threadInfos: [],
        orderedPinnedIds: undefined,
        totalChatCount: 0,
        messages: [],
        notifyExceptionById: {},
        lastMessageByChatId: {},
      };
    }
    await ensureSynced();

    const users: ApiUser[] = [];
    const chats: ApiChat[] = [];
    const userStatusesById: Record<string, ApiUserStatus> = {};

    store.getKnownUserAddresses().forEach((address) => {
      const user = store.buildApiUser(address);
      users.push(user);
      userStatusesById[user.id] = RECENT_STATUS;
      chats.push(store.buildApiChatForUser(address));
    });
    store.getGroupAddresses().forEach((address) => {
      chats.push(store.buildApiChatForGroup(store.getGroupInfo(address)!));
    });

    const chatIdsWithHistory = new Set(store.getChatIds());
    const listedChats = chats.filter(
      (chat) => chatIdsWithHistory.has(chat.id) || chat.type !== 'chatTypePrivate' || chat.id !== selfId(),
    );
    const visibleChats = listedChats.filter(
      (chat) => chatIdsWithHistory.has(chat.id) || chat.type !== 'chatTypePrivate',
    );

    const messages: ApiMessage[] = [];
    const lastMessageByChatId: Record<string, number> = {};
    const threadReadStatesById: Record<string, ThreadReadState> = {};
    const threadInfos: ApiThreadInfo[] = [];
    visibleChats.forEach((chat) => {
      const history = store.getMessages(chat.id);
      const last = history[history.length - 1];
      if (last) {
        messages.push(last);
        lastMessageByChatId[chat.id] = last.id;
        // Реальное прочтение: входящее прочитано, только если МЫ уже слали
        // msg.chat.read (флаг read из синка). Иначе tt не видит непрочитанных
        // и никогда не зовёт markMessageListRead → ✓✓ у собеседника не будет.
        let lastReadInbox = 0;
        let unreadCount = 0;
        const isSelfChat = chat.id === selfId();
        history.forEach((message) => {
          // Sealed-сообщения без senderId и «Избранное» непрочитанными не считаем
          if (message.isOutgoing || isSelfChat || !message.senderId) return;
          const uuid = store.getUuidForMessage(chat.id, message.id);
          if (uuid && wireFlagsByUuid.get(uuid)?.read) {
            if (message.id > lastReadInbox) lastReadInbox = message.id;
          } else {
            unreadCount += 1;
          }
        });
        if (isSelfChat) lastReadInbox = last.id;
        threadReadStatesById[chat.id] = {
          lastReadInboxMessageId: lastReadInbox,
          unreadCount,
          lastReadOutboxMessageId: readOutboxMaxByChatId.get(chat.id),
        };
      }
      // Без ApiThreadInfo главного треда updateListedIds молча не создаёт тред —
      // лента сообщений навсегда остаётся в спиннере
      threadInfos.push({
        isCommentsInfo: false,
        chatId: chat.id,
        threadId: MAIN_THREAD_ID,
        lastMessageId: last?.id,
      });
    });

    return {
      chatIds: visibleChats.map((chat) => chat.id),
      chats: visibleChats,
      users,
      userStatusesById,
      draftsById: {},
      threadReadStatesById,
      threadInfos,
      orderedPinnedIds: undefined,
      totalChatCount: visibleChats.length,
      messages,
      notifyExceptionById: {},
      lastMessageByChatId,
    };
  },

  async fetchMessages({ chat, limit }: { chat: ApiChat; limit: number }) {
    await ensureSynced();
    const history = store.getMessages(chat.id);
    const messages = history.slice(-Math.max(limit, 1) * 2);
    return {
      messages,
      users: collectUsersFor(messages),
      chats: [chat],
      count: history.length,
      topics: [],
    };
  },

  fetchMessagesById({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
    const byId = new Map(store.getMessages(chat.id).map((m) => [m.id, m]));
    return Promise.resolve(messageIds.map((id) => byId.get(id)).filter(Boolean));
  },

  editMessage({ chat, message, text }: { chat: ApiChat; message: ApiMessage; text: string }) {
    const uuid = store.getUuidForMessage(chat.id, message.id);
    if (!uuid || !connection) return Promise.resolve(undefined);

    const event = buildWireEvent(store.self, token, { message_id: uuid, text });
    connection.publish(TOPIC_MSG_EDIT, JSON.stringify(event));

    // Оптимистичное эхо; каноничное состояние догонит дельта-синк
    const edited: ApiMessage = {
      ...message, content: { text: { text } }, isEdited: true,
    };
    store.putMessage(edited);
    sendUpdate({
      '@type': 'updateMessage', chatId: chat.id, id: message.id, isFull: true, message: edited,
    });
    return Promise.resolve(undefined);
  },

  deleteMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
    if (!connection) return Promise.resolve(undefined);
    messageIds.forEach((id) => {
      const uuid = store.getUuidForMessage(chat.id, id);
      if (!uuid) return;
      const event = buildWireEvent(store.self, token, { message_id: uuid });
      connection!.publish(TOPIC_MSG_DELETE, JSON.stringify(event));
      const flags = wireFlagsByUuid.get(uuid);
      if (flags) flags.deleted = true;
    });
    sendUpdate({ '@type': 'deleteMessages', ids: messageIds, chatId: chat.id });
    return Promise.resolve(undefined);
  },

  sendReaction({ chat, messageId, reactions }: {
    chat: ApiChat; messageId: number; reactions?: { type: string; emoticon?: string }[];
  }) {
    const uuid = store.getUuidForMessage(chat.id, messageId);
    if (!uuid || !connection) return Promise.resolve(undefined);

    const first = reactions?.find((r) => r.type === 'emoji');
    const emoji = first?.emoticon || '';
    const event = buildWireEvent(store.self, token, { message_id: uuid, emoji });
    connection.publish(TOPIC_MSG_REACT, JSON.stringify(event));

    // Оптимистично: снять свою прежнюю, добавить новую
    const message = store.getMessages(chat.id).find((m) => m.id === messageId);
    if (message) {
      let results = (message.reactions?.results || []).map((r) => {
        if (r.chosenOrder === undefined) return r;
        return { ...r, chosenOrder: undefined, count: r.count - 1 };
      }).filter((r) => r.count > 0);
      if (emoji) {
        const existing = results.find(
          (r) => r.reaction.type === 'emoji' && r.reaction.emoticon === emoji,
        );
        results = existing
          ? results.map((r) => (r === existing ? { ...r, count: r.count + 1, chosenOrder: 0 } : r))
          : [...results, { count: 1, reaction: { type: 'emoji' as const, emoticon: emoji }, chosenOrder: 0 }];
      }
      const updated: ApiMessage = { ...message, reactions: { results } };
      store.putMessage(updated);
      sendUpdate({
        '@type': 'updateMessageReactions', chatId: chat.id, id: messageId, reactions: { results },
      });
    }
    return Promise.resolve(true);
  },

  pinMessage({ chat, messageId, isUnpin }: { chat: ApiChat; messageId: number; isUnpin: boolean }) {
    const uuid = store.getUuidForMessage(chat.id, messageId);
    if (!uuid || !connection) return Promise.resolve(undefined);
    const event = buildWireEvent(store.self, token, { message_id: uuid, pin: !isUnpin });
    connection.publish(TOPIC_MSG_PIN, JSON.stringify(event));
    sendUpdate({
      '@type': 'updatePinnedIds', chatId: chat.id, isPinned: !isUnpin, messageIds: [messageId],
    });
    return Promise.resolve(undefined);
  },

  fetchPinnedMessages({ chat }: { chat: ApiChat }) {
    const messages = store.getMessages(chat.id).filter((m) => m.isPinned);
    return Promise.resolve({
      messages, users: collectUsersFor(messages), chats: [chat], count: messages.length, topics: [],
    });
  },

  sendMessageAction({ peer, action }: { peer: { id: string }; action: { type: string } }) {
    if (action.type !== 'typing' || !connection) return Promise.resolve(undefined);
    const toAddress = store.getAddressForId(peer.id);
    if (!toAddress) return Promise.resolve(undefined);
    connection.publish(`msg.typing.${peer.id}`, JSON.stringify({ from: store.self, to: toAddress }));
    return Promise.resolve(undefined);
  },

  markMessageListRead({ chat, maxId }: { chat: ApiChat; maxId?: number }) {
    store.getMessages(chat.id).forEach((message) => {
      if (message.isOutgoing || (maxId && message.id > maxId)) return;
      const uuid = store.getUuidForMessage(chat.id, message.id);
      if (!uuid || reportedReadUuids.has(uuid)) return;
      reportedReadUuids.add(uuid);
      const readEvent = buildWireEvent(store.self, token, { message_id: uuid });
      connection!.publish(TOPIC_MSG_READ, JSON.stringify(readEvent));
    });
    return Promise.resolve(undefined);
  },

  sendMessageLocal(params: SendMessageParams) {
    const { chat, text, replyInfo } = params;
    if (!chat) return Promise.resolve(undefined);

    const uuid = crypto.randomUUID();
    const id = store.allocateMessageId(chat.id, uuid);
    const replyToMsgId = replyInfo?.type === 'message' ? replyInfo.replyToMsgId : undefined;
    const localMessage: ApiMessage = {
      id,
      chatId: chat.id,
      content: { text: { text: text || '' } },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: selfId(),
      sendingState: 'messageSendingStatePending',
      replyInfo: replyToMsgId ? { type: 'message', replyToMsgId } : undefined,
    };
    uuidBySentLocalKey.set(`${chat.id}:${id}`, uuid);

    sendUpdate({
      '@type': 'newMessage',
      chatId: chat.id,
      id,
      message: localMessage,
      wasDrafted: params.wasDrafted,
    });
    return Promise.resolve(localMessage);
  },

  async sendMessage(params: SendMessageParams, _onProgress?: ApiOnProgress) {
    const localMessage = params.localMessage
      || await methods.sendMessageLocal(params);
    const { chat } = params;
    if (!localMessage || !chat) return;

    const toAddress = store.getAddressForId(chat.id);
    if (!toAddress) return;

    const uuid = uuidBySentLocalKey.get(`${chat.id}:${localMessage.id}`) || crypto.randomUUID();
    const replyToMsgId = params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined;
    const replyToUuid = replyToMsgId ? store.getUuidForMessage(chat.id, replyToMsgId) : undefined;
    const event = {
      id: uuid,
      from: store.self,
      ts: Math.floor(Date.now() / 1000),
      token,
      payload: {
        to: toAddress,
        content: { kind: 'text', text: params.text || '' },
        reply_to: replyToUuid,
      },
    };
    connection!.publish(TOPIC_MSG_SEND, JSON.stringify(event));

    const sentMessage: ApiMessage = { ...localMessage, sendingState: undefined };
    store.putMessage(sentMessage);
    sendUpdate({
      '@type': 'updateMessageSendSucceeded',
      chatId: chat.id,
      localId: localMessage.id,
      message: sentMessage,
    });
  },

  async searchChats({ query }: { query: string }) {
    if (!connection || !query.trim()) {
      return { accountResultIds: [], globalResultIds: [] };
    }
    const raw = await connection.request(TOPIC_IDENTITY_SEARCH, JSON.stringify({ query: query.trim() }));
    const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
    const globalResultIds: string[] = [];
    users.forEach((u) => {
      if (u.username === store.self) return;
      store.setDisplayName(u.username, u.display_name || u.username);
      announcePeer(u.username);
      globalResultIds.push(store.getIdForAddress(u.username));
    });
    return { accountResultIds: [], globalResultIds };
  },

  searchMessagesGlobal({ query }: { query?: string }) {
    return Promise.resolve(buildSearchResults(searchLocalMessages(query)));
  },

  searchMessagesInChat({ peer, query }: { peer: { id: string }; query?: string }) {
    return Promise.resolve(buildSearchResults(searchLocalMessages(query, peer.id)));
  },

  oldFetchLangPack({ langCode }: { langCode: string }) {
    return Promise.resolve({ langPack: buildOldLangPack(langCode) });
  },

  // ── логин через штатные Auth-экраны ────────────────────────────────────────
  // «Телефон» = федеративный адрес user@server; дальше нативный экран пароля

  provideAuthPhoneNumber(address: string) {
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) {
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ErrorPhoneNumberInvalid' } });
      return Promise.resolve(undefined);
    }
    pendingLoginAddress = address;
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
    return Promise.resolve(undefined);
  },

  async provideAuthPassword(password: string) {
    const user = pendingLoginAddress || readCreds()?.user;
    if (!user) {
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
      return;
    }
    try {
      await connectAndLogin(user, password);
      localStorage.setItem(CREDS_STORAGE_KEY, `${user}:${password}`);
    } catch (err) {
      logDebug(`логин отклонён: ${String(err)}`);
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ErrorIncorrectPassword' } });
    }
  },

  restartAuth() {
    pendingLoginAddress = '';
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
    return Promise.resolve(undefined);
  },

  async fetchContactList() {
    await ensureSynced();
    const users = store.getKnownUserAddresses()
      .filter((address) => address !== store.self)
      .map((address) => store.buildApiUser(address));
    const userStatusesById: Record<string, ApiUserStatus> = {};
    users.forEach((u) => { userStatusesById[u.id] = RECENT_STATUS; });
    return { users, userStatusesById };
  },

  fetchCurrentUser() {
    return Promise.resolve(undefined);
  },

  updateIsOnline() {
    return Promise.resolve(undefined);
  },

  destroy(noSessionClear?: boolean) {
    connection?.close();
    connection = undefined;
    if (!noSessionClear) {
      localStorage.removeItem(CREDS_STORAGE_KEY);
    }
    return Promise.resolve(undefined);
  },

  disconnect() {
    return Promise.resolve(undefined);
  },
};

function selfId() {
  return store.getIdForAddress(store.self);
}

function searchLocalMessages(query: string | undefined, chatId?: string): ApiMessage[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return [];
  const chatIds = chatId ? [chatId] : store.getChatIds();
  return chatIds
    .flatMap((id) => store.getMessages(id))
    .filter((m) => m.content.text?.text.toLowerCase().includes(needle))
    .sort((a, b) => b.date - a.date);
}

function buildSearchResults(messages: ApiMessage[]) {
  return {
    messages,
    topics: [],
    userStatusesById: {},
    totalCount: messages.length,
  };
}

function collectUsersFor(messages: ApiMessage[]): ApiUser[] {
  const ids = new Set<string>();
  messages.forEach((m) => m.senderId && ids.add(m.senderId));
  return Array.from(ids)
    .map((id) => store.getAddressForId(id))
    .filter(Boolean)
    .map((address) => store.buildApiUser(address));
}

function sendUpdate(update: ApiUpdate) {
  onUpdate(update);
}

// Хэш разбираем при загрузке модуля: telegram-tt сам парсит и чистит
// location.hash в своём bootstrap'е раньше, чем дойдёт до initApi
captureCredsFromHash();

function captureCredsFromHash() {
  const { hash } = window.location;
  if (!hash.startsWith(LOGIN_HASH_PREFIX)) return;
  const raw = decodeURIComponent(hash.slice(LOGIN_HASH_PREFIX.length));
  localStorage.setItem(CREDS_STORAGE_KEY, raw);
  window.history.replaceState(undefined, '', window.location.pathname);
}

function readCreds(): { user: string; password: string } | undefined {
  const saved = localStorage.getItem(CREDS_STORAGE_KEY);
  if (!saved) return undefined;
  const colonIndex = saved.lastIndexOf(':');
  if (colonIndex < 0) return undefined;
  return { user: saved.slice(0, colonIndex), password: saved.slice(colonIndex + 1) };
}

// ── интерфейс connector'а ────────────────────────────────────────────────────

export function callApi<T extends keyof Methods>(fnName: T, ...args: MethodArgs<T>): MethodResponse<T> {
  const method = (methods as Record<string, AnyFunction>)[fnName as string];
  if (!method) {
    if (!reportedMissingMethods.has(fnName as string)) {
      reportedMissingMethods.add(fnName as string);
      // eslint-disable-next-line no-console
      console.debug(`[parvane] метод не реализован: ${String(fnName)}`);
    }
    return Promise.resolve(undefined) as MethodResponse<T>;
  }
  return method(...args) as MethodResponse<T>;
}

export const callApiLocal = callApi;

export function cancelApiProgress(progressCallback: ApiOnProgress) {
  progressCallback.isCanceled = true;
}

// Мультитаб-мост и localDb — атрибуты MTProto-воркера, в Parvane не нужны
export function cancelApiProgressMaster(_messageId: string) {}

export function handleMethodCallback(_data: unknown) {}

export function handleMethodResponse(_data: unknown) {}

export function updateFullLocalDb(_initial: unknown) {}

export function updateLocalDb(_name: unknown, _prop?: unknown, _value?: unknown) {}

export function setShouldEnableDebugLog(_value: boolean) {
  return Promise.resolve(undefined);
}
