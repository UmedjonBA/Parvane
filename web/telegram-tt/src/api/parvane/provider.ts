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
  WireEvent, WireGroupInfo, WireMessageContent, WireStoredMessage, WireUserInfo,
} from './wire';

import { GatewayConnection, getGatewayUrl } from './gateway';
import { buildOldLangPack } from './oldLangPack';
import { buildWebPage, ParvaneStore } from './store';
import { PollStore } from './polls';
import { CallEngine } from './callengine';
import type { CallMedia, WireCallSignal } from './callengine';
import {
  buildMsgInboxTopic,
  buildWireEvent,
  TOPIC_FILE_DOWNLOAD_REQUEST,
  TOPIC_FILE_UPLOAD_CHUNK,
  TOPIC_FILE_UPLOAD_COMPLETE,
  TOPIC_GROUP_ADD_MEMBER,
  TOPIC_GROUP_BAN,
  TOPIC_GROUP_CREATE,
  TOPIC_GROUP_INFO,
  TOPIC_GROUP_INVITE_CREATE,
  TOPIC_GROUP_JOIN,
  TOPIC_GROUP_LIST,
  TOPIC_GROUP_MUTE,
  TOPIC_GROUP_REMOVE_MEMBER,
  TOPIC_GROUP_UNBAN,
  TOPIC_IDENTITY_ISSUE,
  TOPIC_IDENTITY_REGISTER,
  TOPIC_IDENTITY_RESOLVE,
  TOPIC_IDENTITY_SEARCH,
  TOPIC_IDENTITY_SETAVATAR,
  TOPIC_IDENTITY_SETNAME,
  TOPIC_MSG_ACK,
  TOPIC_MSG_DELETE,
  TOPIC_MSG_EDIT,
  TOPIC_MSG_PIN,
  TOPIC_MSG_REACT,
  TOPIC_MSG_READ,
  TOPIC_MSG_SEND,
  TOPIC_MSG_SYNC_REQUEST,
  TOPIC_PREKEYS_FETCH,
  TOPIC_PREKEYS_PUBLISH,
  TOPIC_CALL_SIGNAL,
  buildCallInboxTopic,
} from './wire';
import { E2eEngine } from './e2e';
import { decryptBlob, encryptBlob } from './blobcrypt';
import { apiEntitiesToWire } from './entities';

const CREDS_STORAGE_KEY = 'parvane:creds';
const LOGIN_HASH_PREFIX = '#parvane=';
const SYNC_TIMEOUT_MS = 15000;
const DELTA_SYNC_INTERVAL_MS = 10000;
const PRESENCE_INTERVAL_MS = 30000;
const PRESENCE_TTL_SECS = 90;
const TYPING_CLEAR_MS = 6000;
const UPLOAD_CHUNK_BYTES = 192 * 1024;
const MEDIA_TIMEOUT_MS = 30000;

let onUpdate: OnApiUpdate = () => undefined;
let connection: GatewayConnection | undefined;
let store = new ParvaneStore();
let token = '';
let pendingLoginAddress = '';
let isSynced = false;
let syncPromise: Promise<void> | undefined;
let syncTimer: number | undefined;
let presenceTimer: number | undefined;
let e2e: E2eEngine | undefined;
const polls = new PollStore();
let callEngine: CallEngine | undefined;
// Стримы звонка отдаём в UI-слой через глобальные хуки (nativett-панель не
// подключаем — она завязана на MTProto phone-протокол)
const callListeners = {
  onState: (_s: string) => {},
  onRemoteStream: (_s: MediaStream) => {},
  onLocalStream: (_s: MediaStream) => {},
  onIncoming: (_from: string, _callId: string, _media: CallMedia) => {},
};
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
  polls.setSelf(user);
  isSynced = false;
  syncPromise = undefined;
  lastSeenUuid = '';
  sinceUpdated = 0;
  wireFlagsByUuid.clear();
  readOutboxMaxByChatId.clear();
  reportedReadUuids.clear();

  try {
    e2e = await E2eEngine.create(user);
    const prekeys = e2e.buildPrekeysPayload(token);
    if (prekeys) {
      await connection.request(TOPIC_PREKEYS_PUBLISH, JSON.stringify(prekeys));
      logDebug('E2E готов, прекеи опубликованы');
    } else {
      logDebug('E2E готов (прекеи уже опубликованы ранее)');
    }
  } catch (err) {
    e2e = undefined;
    logDebug(`E2E недоступен: ${String(err)}`);
  }

  connection.subscribe(buildMsgInboxTopic(user), handleInboxFrame);
  connection.subscribe(`msg.typing.${selfId()}`, handleTypingFrame);
  connection.subscribe('presence.*', handlePresenceFrame);
  connection.subscribe(buildCallInboxTopic(user), handleCallFrame);
  setupCallEngine();
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

// ── звонки ───────────────────────────────────────────────────────────────────

function setupCallEngine() {
  // Мост в window для UI-слоя/тестов: состояние звонка и входящие
  const w = window as unknown as {
    parvaneCall?: {
      state: string; incoming?: { from: string; callId: string; media: string };
      remoteStream?: MediaStream;
    };
  };
  w.parvaneCall = { state: 'ended' };
  callListeners.onState = (state) => { w.parvaneCall!.state = state; };
  callListeners.onRemoteStream = (stream) => { w.parvaneCall!.remoteStream = stream; };
  callListeners.onIncoming = (from, callId, media) => {
    w.parvaneCall!.incoming = { from, callId, media };
    w.parvaneCall!.state = 'incoming';
  };

  callEngine = new CallEngine({
    sendSignal: (to, signal) => {
      const envelope = buildWireEvent(store.self, token, { to, signal });
      connection!.publish(TOPIC_CALL_SIGNAL, JSON.stringify(envelope));
    },
    onState: (state) => callListeners.onState(state),
    onRemoteStream: (stream) => callListeners.onRemoteStream(stream),
    onIncoming: (from, callId, media) => {
      callListeners.onIncoming(from, callId, media);
    },
  });
}

function handleCallFrame(payload: string) {
  // Call-шард релеит сам сигнал в payload (from = инициатор)
  let event: WireEvent<WireCallSignal>;
  try {
    event = JSON.parse(payload);
  } catch {
    return;
  }
  const signal = event.payload;
  if (!signal?.type || !callEngine) return;
  void callEngine.handleSignal(event.from, signal);
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
  const serverMessages = parsed.payload?.messages || [];
  serverMessages.forEach(trackCursors);

  // Свои sealed приходят только из локального журнала — мержим по ts,
  // чтобы нумерация msgId сохранила хронологию
  const knownIds = new Set(serverMessages.map((m) => m.id));
  const journal = readOwnJournal().filter((m) => !knownIds.has(m.id));

  const ordered = serverMessages.concat(journal)
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  // Проход 1: сперва расшифровываем ВСЕ 1-на-1 (в т.ч. SKDM — импорт групповых
  // ключей) — иначе group_encrypted мог обработаться раньше своего ключа
  // (реордер при полном синке). Результат кэшируется, ratchet не гоняется дважды
  ordered.forEach((rawStored) => {
    if (rawStored.content.kind === 'encrypted') unsealStored(rawStored);
  });

  // Проход 2: рендер (group_encrypted теперь имеет ключ; 1-на-1 берут из кэша)
  ordered.forEach((rawStored) => {
    const { stored, hidden } = unsealStored(rawStored);
    if (hidden) return; // SKDM — служебное
    if (handlePollContent(stored)) return; // голос/закрытие опроса — служебное
    rememberMediaKeys(stored.content); // и для своих journaled медиа
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
    // TTL с учётом прошедшего времени: осталось = ttl - (сейчас - ts)
    if (stored.content.ttl_secs) {
      const remaining = stored.content.ttl_secs - (Math.floor(Date.now() / 1000) - stored.ts);
      scheduleTtlDeletion(message.chatId, message.id, Math.max(0, remaining));
    }
  });

  const peerAddresses = new Set<string>();
  serverMessages.concat(journal).forEach((m) => {
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
    users.forEach((u) => {
      store.setDisplayName(u.username, u.display_name || u.username);
      const prevAvatar = store.getAvatar(u.username);
      store.setAvatar(u.username, u.avatar);
      // Аватар сменился — переотдаём ApiUser, чтобы UI перекачал
      if (u.avatar !== prevAvatar && u.username !== store.self) {
        const user = store.buildApiUser(u.username);
        sendUpdate({ '@type': 'updateUser', id: user.id, user });
      }
    });
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

  void applyStoredUpdate(stored, true);
}

// Сообщение в незнакомую группу — сперва подтягиваем свежий список групп,
// иначе оно ошибочно ляжет в личку отправителя
// Sealed sender: пробуем расшифровать; удачное — в dec-cache (повторная
// расшифровка Olm невозможна — ratchet уехал, а веб фулл-синкает при старте)
type UnsealResult = { stored: WireStoredMessage; wasSealed: boolean; hidden?: boolean };

function unsealStored(stored: WireStoredMessage): UnsealResult {
  const content = stored.content;

  // Групповое E2E (Megolm): расшифровываем входящей group-сессией
  if (content.kind === 'group_encrypted') {
    const cachedG = e2e?.getCachedInner(stored.id);
    if (cachedG) {
      rememberMediaKeys(cachedG.content as WireMessageContent);
      return { stored: { ...stored, content: cachedG.content as WireMessageContent }, wasSealed: true };
    }
    if (!e2e || !content.ciphertext || !content.group || !content.sender_identity) {
      return { stored, wasSealed: false };
    }
    const plainG = e2e.groupDecrypt(content.group, content.sender_identity, content.ciphertext);
    if (!plainG) return { stored, wasSealed: false };
    try {
      const inner = JSON.parse(plainG) as WireMessageContent;
      e2e.cacheInner(stored.id, { from: stored.from, content: inner });
      rememberMediaKeys(inner);
      return { stored: { ...stored, content: inner }, wasSealed: true };
    } catch {
      return { stored, wasSealed: false };
    }
  }

  if (content.kind !== 'encrypted') return { stored, wasSealed: false };

  const cached = e2e?.getCachedInner(stored.id);
  if (cached) {
    rememberMediaKeys(cached.content as WireMessageContent);
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

    // SKDM (раздача группового ключа) — импортируем, сообщение НЕ показываем
    if (inner.content?.kind === 'skdm' && inner.content.group && inner.content.session_key) {
      e2e.acceptGroupKey(
        inner.content.group, inner.content.sender_identity!, inner.content.session_key, inner.content.epoch || 0,
      );
      return { stored, wasSealed: true, hidden: true };
    }

    e2e.cacheInner(stored.id, inner);
    rememberMediaKeys(inner.content);
    return { stored: { ...stored, from: inner.from, content: inner.content }, wasSealed: true };
  } catch {
    return { stored, wasSealed: false };
  }
}

// Раздаёт session_key группы каждому участнику 1-на-1 sealed (SKDM). true —
// хотя бы одному доставлен (иначе шифровать бессмысленно, никто не расшифрует)
async function distributeGroupKey(group: string, members: string[]): Promise<boolean> {
  if (!e2e) return false;
  const { sessionKey, epoch } = e2e.getGroupSessionKey(group);
  const skdmContent = {
    kind: 'skdm', group, session_key: sessionKey, sender_identity: e2e.identityKey, epoch,
  };
  const innerJson = JSON.stringify({ from: store.self, content: skdmContent });

  let delivered = false;
  for (const member of members) {
    if (member === store.self) continue;
    try {
      const encrypted = await e2e.encryptFor(member, innerJson, fetchPrekeyBundle);
      if (!encrypted) continue;
      const skdmEvent = {
        id: crypto.randomUUID(),
        from: '',
        ts: Math.floor(Date.now() / 1000),
        token,
        payload: {
          to: member,
          content: {
            kind: 'encrypted',
            ciphertext: encrypted.ciphertext,
            ctype: encrypted.ctype,
            sender_identity: encrypted.sender_identity,
          },
        },
      };
      connection!.publish(TOPIC_MSG_SEND, JSON.stringify(skdmEvent));
      delivered = true;
    } catch {
      // нет бандла участника — получит ключ при следующей отправке
    }
  }
  return delivered;
}

// Публикует произвольный inner-content с тем же E2E-выбором, что sendMessage:
// группа → SKDM + group_encrypted; личка → sealed; иначе открыто. Для служебных
// сообщений опросов (poll/poll_vote/poll_close). Возвращает uuid отправленного
// ── опросы ───────────────────────────────────────────────────────────────────

async function sendPoll(chat: ApiChat, newPoll: { summary: { question: { text: string }; answers: { text: { text: string } }[]; isPublic?: true; isMultipleChoice?: true } }) {
  const toAddress = store.getAddressForId(chat.id);
  if (!toAddress) return;
  const question = newPoll.summary.question.text;
  const options = newPoll.summary.answers.map((a) => a.text.text);
  const uuid = crypto.randomUUID();

  polls.register(uuid, chat.id, question, options, {
    isPublic: Boolean(newPoll.summary.isPublic),
    isMultiple: Boolean(newPoll.summary.isMultipleChoice),
  });

  await publishInner(toAddress, {
    kind: 'poll',
    question,
    options,
    is_public: newPoll.summary.isPublic || undefined,
    is_multiple: newPoll.summary.isMultipleChoice || undefined,
  }, uuid);

  const id = store.allocateMessageId(chat.id, uuid);
  const message: ApiMessage = {
    id,
    chatId: chat.id,
    content: { pollId: uuid },
    date: Math.floor(Date.now() / 1000),
    isOutgoing: true,
    senderId: selfId(),
  };
  store.putMessage(message);
  sendUpdate({
    '@type': 'newMessage', chatId: chat.id, id, message, poll: polls.build(uuid),
  });
}

// Применяет агрегат опроса к сообщению и перерисовывает
function refreshPollMessage(uuid: string) {
  const chatId = polls.getChatId(uuid);
  if (!chatId) return;
  const messageId = store.allocateMessageId(chatId, uuid); // идемпотентно
  const built = polls.build(uuid);
  const message = store.getMessages(chatId).find((m) => m.id === messageId);
  if (built && message) {
    sendUpdate({
      '@type': 'updateMessage', chatId, id: messageId, isFull: true, message, poll: built,
    });
  }
}

async function publishInner(toAddress: string, wireContent: Record<string, unknown>, uuid = crypto.randomUUID()) {
  const ts = Math.floor(Date.now() / 1000);
  const groupInfo = e2e ? store.getGroupInfo(toAddress) : undefined;

  if (groupInfo && e2e) {
    const distributed = await distributeGroupKey(toAddress, groupInfo.members.map((m) => m.address));
    const ciphertext = distributed ? e2e.groupEncrypt(toAddress, JSON.stringify(wireContent)) : undefined;
    if (ciphertext) {
      connection!.publish(TOPIC_MSG_SEND, JSON.stringify({
        id: uuid,
        from: store.self,
        ts,
        token,
        payload: {
          to: toAddress,
          content: {
            kind: 'group_encrypted', ciphertext, group: toAddress, sender_identity: e2e.identityKey,
          },
        },
      }));
      appendOwnJournal({ id: uuid, from: store.self, to: toAddress, content: wireContent as never, ts });
      e2e.cacheInner(uuid, { from: store.self, content: wireContent });
      return uuid;
    }
  }

  const shouldE2e = Boolean(e2e && !store.isGroupAddress(toAddress) && toAddress !== store.self);
  if (shouldE2e && e2e) {
    const inner = JSON.stringify({ from: store.self, content: wireContent });
    const encrypted = await e2e.encryptFor(toAddress, inner, fetchPrekeyBundle);
    if (encrypted) {
      connection!.publish(TOPIC_MSG_SEND, JSON.stringify({
        id: uuid,
        from: '',
        ts,
        token,
        payload: {
          to: toAddress,
          content: {
            kind: 'encrypted', ciphertext: encrypted.ciphertext, ctype: encrypted.ctype, sender_identity: encrypted.sender_identity,
          },
        },
      }));
      appendOwnJournal({ id: uuid, from: store.self, to: toAddress, content: wireContent as never, ts });
      e2e.cacheInner(uuid, { from: store.self, content: wireContent });
      return uuid;
    }
  }

  connection!.publish(TOPIC_MSG_SEND, JSON.stringify({
    id: uuid, from: store.self, ts, token, payload: { to: toAddress, content: wireContent },
  }));
  return uuid;
}

async function fetchPrekeyBundle(user: string) {
  const raw = await connection!.request(TOPIC_PREKEYS_FETCH, JSON.stringify({ token, user }));
  return JSON.parse(raw) as {
    ok: boolean; identity_key?: string; signed_prekey?: string; one_time?: string;
  };
}

// Журнал СВОИХ sealed-сообщений: сервер хранит их с from='' и не отдаёт
// отправителю в sync — история своих E2E живёт только локально
function readOwnJournal(): WireStoredMessage[] {
  try {
    return JSON.parse(localStorage.getItem(`parvane:hist:${store.self}`) || '[]');
  } catch {
    return [];
  }
}

function appendOwnJournal(entry: WireStoredMessage) {
  const list = readOwnJournal();
  list.push(entry);
  localStorage.setItem(`parvane:hist:${store.self}`, JSON.stringify(list));
}

// TTL самоуничтожения по чату (адрес → секунды), персист localStorage.
// ttl_secs едет ВНУТРИ E2E-content (сервер не знает); обе стороны заводят
// таймер локального удаления — эфемерно (не журналим, не кэшируем)
function loadPeerTtl(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(`parvane:ttl:${store.self}`) || '{}');
  } catch {
    return {};
  }
}

function savePeerTtl(map: Record<string, number>) {
  localStorage.setItem(`parvane:ttl:${store.self}`, JSON.stringify(map));
}

function scheduleTtlDeletion(chatId: string, messageId: number, ttlSecs: number) {
  window.setTimeout(() => {
    store.removeMessage(chatId, messageId);
    sendUpdate({ '@type': 'deleteMessages', ids: [messageId], chatId });
  }, ttlSecs * 1000);
}

// Обрабатывает poll-контент. Возвращает true, если это служебное голосование/
// закрытие (не рендерим как сообщение). poll (создание) рендерится обычным путём
function handlePollContent(stored: WireStoredMessage): boolean {
  const c = stored.content;
  if (c.kind === 'poll') {
    const chatAddress = store.isGroupAddress(stored.to) ? stored.to
      : (stored.from && stored.from !== store.self ? stored.from : stored.to);
    const chatId = store.getIdForAddress(chatAddress, store.isGroupAddress(chatAddress) ? 'group' : 'user');
    polls.register(stored.id, chatId, (c as { question?: string }).question || '',
      (c as { options?: string[] }).options || [], {
        isPublic: Boolean((c as { is_public?: boolean }).is_public),
        isMultiple: Boolean((c as { is_multiple?: boolean }).is_multiple),
      });
    return false; // создание рендерим
  }
  if (c.kind === 'poll_vote') {
    const pollUuid = (c as { poll?: string }).poll;
    const opts = (c as { options?: number[] }).options || [];
    if (pollUuid && stored.from) {
      polls.applyVote(pollUuid, stored.from, opts);
      refreshPollMessage(pollUuid);
    }
    return true;
  }
  if (c.kind === 'poll_close') {
    const pollUuid = (c as { poll?: string }).poll;
    if (pollUuid) {
      polls.close(pollUuid);
      refreshPollMessage(pollUuid);
    }
    return true;
  }
  return false;
}

const checkedGroupCandidates = new Set<string>();

async function refreshGroupsIfUnknownChat(stored: WireStoredMessage) {
  // Кандидат в группы: входящее, адресат — не я и не известная группа
  if (!stored.to || stored.to === store.self || stored.from === store.self
    || store.isGroupAddress(stored.to) || checkedGroupCandidates.has(stored.to)) {
    return;
  }
  checkedGroupCandidates.add(stored.to);
  try {
    const raw = await connection!.request(TOPIC_GROUP_LIST, JSON.stringify({ token }));
    const groups = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups || [];
    groups.forEach((info) => {
      const isNew = !store.isGroupAddress(info.group_id);
      store.registerGroup(info);
      if (isNew) {
        const chat = store.buildApiChatForGroup(info);
        sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
      }
    });
  } catch {
    // список групп догоним следующим синком
  }
}

// Общий приёмник состояния сообщения — и для инбокс-пуша, и для дельта-синка.
// Новое → newMessage; мутации known → deleteMessages / updateMessage / ✓✓.
async function applyStoredUpdate(rawStored: WireStoredMessage, shouldAckIncoming: boolean) {
  trackCursors(rawStored);
  const { stored, wasSealed, hidden } = unsealStored(rawStored);
  // SKDM (групповой ключ) — служебное, не показываем, но ackّаем чтобы снять
  // из офлайн-очереди
  if (hidden) {
    if (shouldAckIncoming) sendAck(rawStored.id, stored.from);
    return;
  }
  await refreshGroupsIfUnknownChat(stored);
  // Голоса/закрытие опросов — служебные, не рендерим (ack снимает из очереди)
  if (handlePollContent(stored)) {
    if (shouldAckIncoming && stored.from !== store.self) sendAck(rawStored.id, wasSealed ? stored.from : '');
    return;
  }
  rememberMediaKeys(stored.content);
  const prevFlags = wireFlagsByUuid.get(stored.id);
  const flags = buildWireFlags(stored);
  wireFlagsByUuid.set(stored.id, flags);

  const isKnown = store.hasMessage(stored.id);
  const message = store.buildApiMessage(stored);
  store.putMessage(message);

  if (!message.isOutgoing && shouldAckIncoming) {
    sendAck(stored.id, wasSealed ? stored.from : '');
  }

  if (!isKnown) {
    if (!message.isOutgoing && stored.from) {
      announcePeer(stored.from);
    }
    const webPage = buildWebPage(stored);
    sendUpdate({
      '@type': 'newMessage',
      chatId: message.chatId,
      id: message.id,
      message,
      webPages: webPage ? [webPage] : undefined,
      poll: stored.content.kind === 'poll' ? polls.build(stored.id) : undefined,
    });
    if (flags.read && message.isOutgoing) noteReadOutbox(message);
    // Эфемерное: заводим таймер удаления у получателя
    if (stored.content.ttl_secs) {
      scheduleTtlDeletion(message.chatId, message.id, stored.content.ttl_secs);
    }
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
  const sorted = messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  for (const stored of sorted) {
    await applyStoredUpdate(stored, true);
  }
}

function announcePeer(address: string) {
  if (store.isGroupAddress(address)) return;
  const user = store.buildApiUser(address);
  sendUpdate({ '@type': 'updateUser', id: user.id, user });
  sendUpdate({ '@type': 'updateChat', id: user.id, chat: store.buildApiChatForUser(address) });
  void resolveDisplayNames([address]);
}

function sendAck(messageId: string, sealedSender: string) {
  const ack = buildWireEvent(store.self, token, { message_id: messageId, sender: sealedSender });
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
    // Опросы: poll-объект не в content, доотдаём отдельными апдейтами после
    // того как сообщения окажутся в global (следующий тик)
    const pollMessages = messages.filter((m) => m.content.pollId);
    if (pollMessages.length) {
      window.setTimeout(() => {
        pollMessages.forEach((m) => m.content.pollId && refreshPollMessage(m.content.pollId));
      }, 0);
    }
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

  async sendPollVote({ chat, messageId, options }: { chat: ApiChat; messageId: number; options: string[] }) {
    const uuid = store.getUuidForMessage(chat.id, messageId);
    const toAddress = store.getAddressForId(chat.id);
    if (!uuid || !toAddress) return undefined;
    const indices = options.map(Number).filter((n) => !Number.isNaN(n));
    polls.applyVote(uuid, store.self, indices);
    refreshPollMessage(uuid);
    await publishInner(toAddress, { kind: 'poll_vote', poll: uuid, options: indices });
    return true;
  },

  async closePoll({ chat, messageId }: { chat: ApiChat; messageId: number }) {
    const uuid = store.getUuidForMessage(chat.id, messageId);
    const toAddress = store.getAddressForId(chat.id);
    if (!uuid || !toAddress) return undefined;
    polls.close(uuid);
    refreshPollMessage(uuid);
    await publishInner(toAddress, { kind: 'poll_close', poll: uuid });
    return true;
  },

  // Установить/снять TTL самоуничтожения для чата (period=0 — снять). TTL
  // хранится локально; едет в ttl_secs каждого исходящего сообщения
  setChatMessageAutoDeletePeriod({ chat, period }: { chat: ApiChat; period: number }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve(undefined);
    const map = loadPeerTtl();
    if (period > 0) map[address] = period;
    else delete map[address];
    savePeerTtl(map);
    return Promise.resolve(true);
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
      content: buildLocalContent(uuid, params),
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
    // Опрос: отдельный поток (kind=poll едет в E2E; агрегация голосов локальна)
    if (params.poll && params.chat) {
      await sendPoll(params.chat, params.poll);
      return;
    }

    const localMessage = params.localMessage
      || await methods.sendMessageLocal(params);
    const { chat, attachment } = params;
    if (!localMessage || !chat) return;

    const toAddress = store.getAddressForId(chat.id);
    if (!toAddress) return;

    const uuid = uuidBySentLocalKey.get(`${chat.id}:${localMessage.id}`) || crypto.randomUUID();
    const replyToMsgId = params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined;
    const replyToUuid = replyToMsgId ? store.getUuidForMessage(chat.id, replyToMsgId) : undefined;

    // E2E доступен для лички с готовым движком (медиа шифруем блобом, текст —
    // sealed content); для группы/себя/без движка — открыто
    const shouldE2e = Boolean(e2e && chat.type === 'chatTypePrivate' && toAddress !== store.self);
    // Медиа в E2E-группе тоже шифруем блобом (file_key едет в group_encrypted)
    const isE2eGroup = Boolean(e2e && store.isGroupAddress(toAddress));
    const shouldEncryptMedia = shouldE2e || isE2eGroup;

    const ttlSecs = loadPeerTtl()[toAddress];
    let wireContent: Record<string, unknown> = {
      kind: 'text', text: params.text || '', entities: apiEntitiesToWire(params.entities),
      webpage: params.noWebPage ? undefined : detectWebPage(params.text),
      ttl_secs: ttlSecs || undefined,
    };
    let sentContent = localMessage.content;
    if (attachment) {
      try {
        const blob: Blob = attachment.blob ?? await fetch(attachment.blobUrl).then((r) => r.blob());
        const { fileId, size, mediaKeys } = await uploadBlobToCloud(
          blob, attachment.filename, attachment.mimeType, shouldEncryptMedia,
        );
        const mediaCrypto = mediaKeys ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64 } : {};
        if (isPhotoAttachment(attachment)) {
          wireContent = {
            kind: 'photo',
            file_id: fileId,
            width: attachment.quick!.width,
            height: attachment.quick!.height,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            photo: {
              mediaType: 'photo',
              id: fileId,
              date: localMessage.date,
              blobUrl: attachment.blobUrl,
              sizes: [
                { type: 'x', width: attachment.quick!.width, height: attachment.quick!.height },
                { type: 'y', width: attachment.quick!.width, height: attachment.quick!.height },
              ],
            },
          };
        } else {
          wireContent = {
            kind: 'file',
            file_id: fileId,
            filename: attachment.filename,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            document: {
              mediaType: 'document',
              id: fileId,
              fileName: attachment.filename,
              size,
              mimeType: attachment.mimeType,
              timestamp: localMessage.date,
            },
          };
        }
      } catch (err) {
        logDebug(`загрузка вложения не удалась: ${String(err)}`);
        sendUpdate({
          '@type': 'updateMessageSendFailed',
          chatId: chat.id,
          localId: localMessage.id,
          error: 'Upload failed',
        });
        return;
      }
    }

    // Группа с E2E (Megolm): раздаём SKDM участникам 1-на-1 sealed, ПОТОМ
    // шлём group_encrypted (from виден серверу для membership-проверки,
    // content непрозрачен). Медиа-блоб уже зашифрован (file_key в content)
    const groupInfo = e2e ? store.getGroupInfo(toAddress) : undefined;
    if (groupInfo && e2e) {
      const distributed = await distributeGroupKey(toAddress, groupInfo.members.map((m) => m.address));
      const ciphertext = distributed
        ? e2e.groupEncrypt(toAddress, JSON.stringify(wireContent))
        : undefined;
      if (ciphertext) {
        const ts = Math.floor(Date.now() / 1000);
        const groupEvent = {
          id: uuid,
          from: store.self,
          ts,
          token,
          payload: {
            to: toAddress,
            content: {
              kind: 'group_encrypted',
              ciphertext,
              group: toAddress,
              sender_identity: e2e.identityKey,
            },
            reply_to: replyToUuid,
          },
        };
        connection!.publish(TOPIC_MSG_SEND, JSON.stringify(groupEvent));
        // Своё групповое эхо не вернётся расшифрованным (from=self, но
        // ciphertext) — журналим плейнтекст и кэшируем
        appendOwnJournal({
          id: uuid, from: store.self, to: toAddress, content: wireContent as unknown as WireMessageContent, ts, reply_to: replyToUuid,
        });
        e2e.cacheInner(uuid, { from: store.self, content: wireContent });
        const sentMessage: ApiMessage = { ...localMessage, sendingState: undefined };
        store.putMessage(sentMessage);
        sendUpdate({
          '@type': 'updateMessageSendSucceeded', chatId: chat.id, localId: localMessage.id, message: sentMessage,
        });
        return;
      }
      logDebug(`E2E-группа: не удалось раздать ключ ${toAddress}, шлю открыто`);
    }

    // E2E sealed sender: весь content (текст ИЛИ медиа-метаданные с file_key)
    // шифруется Olm — сервер не видит ни содержимого, ни отправителя.
    // Нет бандла у пира — честный плейнтекст (лог в консоли)
    let isSealed = false;
    const plainContent = wireContent;
    if (shouldE2e && e2e) {
      try {
        const innerJson = JSON.stringify({ from: store.self, content: wireContent });
        const encrypted = await e2e.encryptFor(toAddress, innerJson, fetchPrekeyBundle);
        if (encrypted) {
          wireContent = {
            kind: 'encrypted',
            ciphertext: encrypted.ciphertext,
            ctype: encrypted.ctype,
            sender_identity: encrypted.sender_identity,
          };
          isSealed = true;
        } else {
          logDebug(`E2E: нет бандла у ${toAddress}, шлю открыто`);
        }
      } catch (err) {
        logDebug(`E2E-шифрование не удалось (${String(err)}), шлю открыто`);
      }
    }

    const ts = Math.floor(Date.now() / 1000);
    const event = {
      id: uuid,
      from: isSealed ? '' : store.self,
      ts,
      token,
      payload: {
        to: toAddress,
        content: wireContent,
        reply_to: replyToUuid,
      },
    };
    connection!.publish(TOPIC_MSG_SEND, JSON.stringify(event));

    // Эфемерное (TTL) не журналим и не кэшируем — исчезает без следа
    if (isSealed && !ttlSecs) {
      // Сервер не отдаст отправителю его sealed — журналим локально
      appendOwnJournal({
        id: uuid,
        from: store.self,
        to: toAddress,
        content: plainContent as unknown as WireMessageContent,
        ts,
        reply_to: replyToUuid,
      });
      e2e!.cacheInner(uuid, { from: store.self, content: plainContent });
    }

    const sentMessage: ApiMessage = { ...localMessage, content: sentContent, sendingState: undefined };
    store.putMessage(sentMessage);
    sendUpdate({
      '@type': 'updateMessageSendSucceeded',
      chatId: chat.id,
      localId: localMessage.id,
      message: sentMessage,
    });
    if (ttlSecs) scheduleTtlDeletion(chat.id, localMessage.id, ttlSecs);
  },

  downloadMedia(
    { url, mediaFormat, start, end }: { url: string; mediaFormat: number; start?: number; end?: number },
    _onProgress?: ApiOnProgress,
  ) {
    // Аватар/профиль-фото: хэш `avatar<id>?<fileId>` — fileId после '?'
    const avatarMatch = url.match(/^(?:avatar|profile)[^?]*\?(.+)$/);
    const mediaMatch = url.match(MEDIA_URL_REGEX);
    const fileId = avatarMatch ? avatarMatch[1] : mediaMatch?.[1];
    if (!fileId) return Promise.resolve(undefined);

    let cached = mediaCacheByFileId.get(fileId);
    if (!cached) {
      cached = downloadBlobFromCloud(fileId);
      mediaCacheByFileId.set(fileId, cached);
      cached.catch(() => mediaCacheByFileId.delete(fileId));
    }
    return cached.then(async (result) => {
      if (!result) return undefined;
      if (mediaFormat === PROGRESSIVE_MEDIA_FORMAT) {
        const buffer = await result.blob.arrayBuffer();
        const slice = buffer.slice(start || 0, end !== undefined ? end + 1 : undefined);
        return { arrayBuffer: slice, mimeType: result.mimeType, fullSize: buffer.byteLength };
      }
      return { dataBlob: result.blob, mimeType: result.mimeType };
    });
  },

  // ── группы ─────────────────────────────────────────────────────────────────

  async createGroupChat({ title, users }: { title: string; users: ApiUser[] }) {
    if (!connection) return undefined;
    const members = users
      .map((u) => store.getAddressForId(u.id))
      .filter(Boolean);
    const raw = await connection.request(TOPIC_GROUP_CREATE, JSON.stringify({
      token, name: title, kind: 'group', members,
    }));
    const resp = JSON.parse(raw) as { ok: boolean; group_id?: string; error?: string };
    if (!resp.ok || !resp.group_id) return undefined;

    const info: WireGroupInfo = {
      group_id: resp.group_id,
      name: title,
      kind: 'group',
      created_by: store.self,
      members: [
        { address: store.self, role: 'owner' },
        ...members.map((address) => ({ address, role: 'member' })),
      ],
    };
    store.registerGroup(info);
    const chat = store.buildApiChatForGroup(info);
    sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
    return { chat, missingUsers: [] };
  },

  async fetchFullChat(chat: ApiChat) {
    const address = store.getAddressForId(chat.id);
    if (!connection || !address) return undefined;
    if (!store.isGroupAddress(address)) {
      return {
        fullInfo: { canViewMembers: false },
        chats: [],
        userStatusesById: {},
      };
    }

    const raw = await connection.request(TOPIC_GROUP_INFO, JSON.stringify({ token, group_id: address }));
    const info = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups?.[0];
    if (!info) return undefined;
    store.registerGroup(info);

    info.members.forEach((m) => {
      const user = store.buildApiUser(m.address);
      sendUpdate({ '@type': 'updateUser', id: user.id, user });
    });
    const members = info.members.map((m) => ({
      userId: store.getIdForAddress(m.address),
      isOwner: m.role === 'owner' ? true as const : undefined,
      isAdmin: m.role === 'admin' ? true as const : undefined,
    }));
    const adminMembers = members.filter((m) => m.isOwner || m.isAdmin);
    return {
      fullInfo: {
        members,
        adminMembersById: Object.fromEntries(adminMembers.map((m) => [m.userId, m])),
        canViewMembers: true,
      },
      chats: [store.buildApiChatForGroup(info)],
      userStatusesById: {},
      membersCount: members.length,
    };
  },

  async addChatMembers(chat: ApiChat, users: ApiUser[]) {
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    if (!groupId) return undefined;
    for (const user of users) {
      const member = store.getAddressForId(user.id);
      if (!member) continue;
      await connection.request(TOPIC_GROUP_ADD_MEMBER, JSON.stringify({ token, group_id: groupId, member }));
    }
    return true;
  },

  async deleteChatMember(chat: ApiChat, user: ApiUser) {
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;
    await connection.request(TOPIC_GROUP_REMOVE_MEMBER, JSON.stringify({ token, group_id: groupId, member }));
    return true;
  },

  // Бан/мьют/разбан участника. bannedRights.viewMessages=true → бан;
  // untilDate (без полного бана) → мьют до времени; пустые права → разбан
  async updateChatMemberBannedRights(
    { chat, user, bannedRights, untilDate }:
    { chat: ApiChat; user: ApiUser; bannedRights: Record<string, unknown>; untilDate?: number },
  ) {
    if (!connection) return undefined;
    const groupId = store.getAddressForId(chat.id);
    const member = store.getAddressForId(user.id);
    if (!groupId || !member) return undefined;

    if (bannedRights.viewMessages) {
      await connection.request(TOPIC_GROUP_BAN, JSON.stringify({ token, group_id: groupId, member }));
    } else if (bannedRights.sendMessages) {
      const until = untilDate || 0;
      await connection.request(TOPIC_GROUP_MUTE, JSON.stringify({
        token, group_id: groupId, member, until,
      }));
    } else {
      await connection.request(TOPIC_GROUP_UNBAN, JSON.stringify({ token, group_id: groupId, member }));
    }
    return true;
  },

  async exportChatInvite({ peer }: { peer: ApiChat }) {
    if (!connection) return undefined;
    const groupId = store.getAddressForId(peer.id);
    if (!groupId) return undefined;
    const raw = await connection.request(TOPIC_GROUP_INVITE_CREATE, JSON.stringify({ token, group_id: groupId }));
    const resp = JSON.parse(raw) as { ok: boolean; invite?: string };
    if (!resp.ok || !resp.invite) return undefined;
    return {
      link: `https://parvane.invite/${resp.invite}`,
      date: Math.floor(Date.now() / 1000),
      isPermanent: true,
      adminId: selfId(),
    };
  },

  async importChatInvite({ hash }: { hash: string }) {
    if (!connection) return undefined;
    // hash — токен инвайта (последний сегмент ссылки parvane.invite/<token>)
    const raw = await connection.request(TOPIC_GROUP_JOIN, JSON.stringify({ token, invite: hash }));
    const resp = JSON.parse(raw) as { ok: boolean; group_id?: string; name?: string };
    if (!resp.ok || !resp.group_id) return undefined;

    // Подтягиваем инфо новой группы и показываем её
    const infoRaw = await connection.request(TOPIC_GROUP_INFO, JSON.stringify({ token, group_id: resp.group_id }));
    const info = (JSON.parse(infoRaw) as { groups?: WireGroupInfo[] }).groups?.[0];
    if (info) {
      store.registerGroup(info);
      const groupChat = store.buildApiChatForGroup(info);
      sendUpdate({ '@type': 'updateChat', id: groupChat.id, chat: groupChat });
      return groupChat;
    }
    return undefined;
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

  // ── звонки (программный API; UI-панель — window.parvaneCalls) ───────────────
  async parvanePlaceCall({ chat, isVideo }: { chat: ApiChat; isVideo?: boolean }) {
    const toAddress = store.getAddressForId(chat.id);
    if (!toAddress || !callEngine || store.isGroupAddress(toAddress)) return undefined;
    await callEngine.placeCall(toAddress, isVideo ? 'video' : 'audio');
    return true;
  },

  async parvaneAcceptCall() {
    if (!callEngine) return undefined;
    return callEngine.acceptIncoming();
  },

  parvaneHangUp() {
    callEngine?.hangUp();
    return Promise.resolve(true);
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

  async updateProfile({ firstName }: { firstName?: string; lastName?: string; about?: string }) {
    if (!connection || !firstName) return undefined;
    await connection.request(TOPIC_IDENTITY_SETNAME, JSON.stringify({ token, display_name: firstName }));
    store.setDisplayName(store.self, firstName);
    const user = store.buildApiUser(store.self);
    sendUpdate({ '@type': 'updateUser', id: user.id, user });
    sendUpdate({ '@type': 'updateCurrentUser', currentUser: user, currentUserFullInfo: {} });
    return true;
  },

  async uploadProfilePhoto(file: File) {
    if (!connection) return undefined;
    const { fileId } = await uploadBlobToCloud(file, file.name || 'avatar.jpg', file.type || 'image/jpeg');
    await connection.request(TOPIC_IDENTITY_SETAVATAR, JSON.stringify({ token, file_id: fileId }));
    store.setAvatar(store.self, fileId);
    mediaCacheByFileId.set(fileId, Promise.resolve({ blob: file, mimeType: file.type || 'image/jpeg' }));
    const user = store.buildApiUser(store.self);
    sendUpdate({ '@type': 'updateUser', id: user.id, user });
    sendUpdate({ '@type': 'updateCurrentUser', currentUser: user, currentUserFullInfo: {} });
    return {
      photo: {
        mediaType: 'photo' as const,
        id: fileId,
        date: Math.floor(Date.now() / 1000),
        sizes: [{ type: 'x' as const, width: 640, height: 640 }],
      },
    };
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

// ── медиа через cloud-шард ───────────────────────────────────────────────────

function encodeBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function decodeBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function uploadBlobToCloud(blob: Blob, filename: string, mimeType: string, encrypt = false) {
  const fileId = crypto.randomUUID();
  let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
  let mediaKeys: { keyB64: string; nonceB64: string } | undefined;
  if (encrypt) {
    // Блоб грузится в cloud ШИФРТЕКСТОМ (сервер не видит содержимого);
    // cloud хранит непрозрачные байты под нейтральным mime
    const enc = await encryptBlob(bytes);
    bytes = enc.ciphertext as Uint8Array;
    mediaKeys = { keyB64: enc.keyB64, nonceB64: enc.nonceB64 };
  }
  const cloudMime = encrypt ? 'application/octet-stream' : mimeType;
  const totalChunks = Math.max(1, Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES));
  for (let index = 0; index < totalChunks; index++) {
    const slice = bytes.subarray(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES);
    const chunkEvent = buildWireEvent(store.self, token, {
      file_id: fileId,
      chunk_index: index,
      total_chunks: totalChunks,
      data: encodeBase64(slice),
      filename,
      mime_type: cloudMime,
    });
    await connection!.request(TOPIC_FILE_UPLOAD_CHUNK, JSON.stringify(chunkEvent), MEDIA_TIMEOUT_MS);
  }
  const completeEvent = buildWireEvent(store.self, token, {
    file_id: fileId,
    filename,
    total_chunks: totalChunks,
    size_bytes: bytes.length,
    mime_type: cloudMime,
  });
  const raw = await connection!.request(TOPIC_FILE_UPLOAD_COMPLETE, JSON.stringify(completeEvent), MEDIA_TIMEOUT_MS);
  const resp = JSON.parse(raw) as { ok: boolean; error?: string };
  if (!resp.ok) throw new Error(resp.error || 'upload.complete отказ');
  // Свой файл кладём в кэш расшифрованным сразу (эхо не качает из cloud заново)
  if (mediaKeys) {
    mediaKeysByFileId.set(fileId, mediaKeys);
    mediaCacheByFileId.set(fileId, Promise.resolve({ blob, mimeType }));
  }
  return { fileId, size: blob.size, mediaKeys };
}

type WireDownloadChunk = {
  ok: boolean;
  chunk_index?: number;
  total_chunks?: number;
  data?: string;
  mime_type?: string;
  error?: string;
};

async function downloadBlobFromCloud(fileId: string): Promise<{ blob: Blob; mimeType: string } | undefined> {
  const event = buildWireEvent(store.self, token, { file_id: fileId });
  const replies = await connection!.requestMany(TOPIC_FILE_DOWNLOAD_REQUEST, JSON.stringify(event));
  const chunks = replies
    .map((r) => JSON.parse(r) as WireDownloadChunk)
    .filter((c) => c.ok && c.data !== undefined && c.chunk_index !== undefined)
    .sort((a, b) => a.chunk_index! - b.chunk_index!);
  if (!chunks.length) return undefined;
  const parts = chunks.map((c) => decodeBase64(c.data!));

  const keys = mediaKeysByFileId.get(fileId);
  if (keys) {
    // E2E-медиа: cloud отдал шифртекст, расшифровываем ключом из sealed content
    const cipher = concatBytes(parts);
    const plain = await decryptBlob(cipher, keys.keyB64, keys.nonceB64);
    if (!plain) return undefined;
    const mimeType = mediaMimeByFileId.get(fileId) || 'application/octet-stream';
    return { blob: new Blob([plain as BlobPart], { type: mimeType }), mimeType };
  }
  const mimeType = chunks[0].mime_type || 'application/octet-stream';
  return { blob: new Blob(parts as BlobPart[], { type: mimeType }), mimeType };
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((p) => { out.set(p, offset); offset += p.length; });
  return out;
}

const MEDIA_URL_REGEX = /^(?:photo|document)([0-9a-f-]{36})/;
const PROGRESSIVE_MEDIA_FORMAT = 1; // ApiMediaFormat.Progressive
const mediaCacheByFileId = new Map<string, Promise<{ blob: Blob; mimeType: string } | undefined>>();
// Ключи расшифровки E2E-медиа по file_id (из sealed content) — downloadMedia
// получает только хэш, ключ ищет здесь
const mediaKeysByFileId = new Map<string, { keyB64: string; nonceB64: string }>();
// Реальный mime E2E-медиа по file_id (в cloud он нейтральный octet-stream)
const mediaMimeByFileId = new Map<string, string>();

function rememberMediaKeys(content: WireMessageContent) {
  if (content.file_id && content.file_key && content.file_nonce) {
    mediaKeysByFileId.set(content.file_id, { keyB64: content.file_key, nonceB64: content.file_nonce });
    if (content.mime) mediaMimeByFileId.set(content.file_id, content.mime);
  }
}

function isPhotoAttachment(attachment: NonNullable<SendMessageParams['attachment']>) {
  return Boolean(
    attachment.mimeType.startsWith('image/') && attachment.quick && !attachment.shouldSendAsFile,
  );
}

function buildLocalContent(uuid: string, params: SendMessageParams): ApiMessage['content'] {
  const { attachment, text, entities } = params;
  const caption = text ? { text: { text } } : {};
  if (!attachment) {
    return { text: { text: text || '', entities } };
  }
  if (isPhotoAttachment(attachment)) {
    return {
      ...caption,
      photo: {
        mediaType: 'photo',
        id: uuid,
        date: Math.floor(Date.now() / 1000),
        blobUrl: attachment.blobUrl,
        sizes: [
          { type: 'x', width: attachment.quick!.width, height: attachment.quick!.height },
          { type: 'y', width: attachment.quick!.width, height: attachment.quick!.height },
        ],
      },
    };
  }
  return {
    ...caption,
    document: {
      mediaType: 'document',
      id: uuid,
      fileName: attachment.filename,
      size: attachment.size,
      mimeType: attachment.mimeType,
      previewBlobUrl: attachment.previewBlobUrl,
    },
  };
}

const URL_REGEX = /https?:\/\/[^\s]+/;

// Минимальный превью первой ссылки: домен как title. Богатые OG-метаданные
// требуют серверного прокси (браузер не читает cross-origin HTML из-за CORS) —
// зато превью от desktop-клиента (с полными полями) отобразится как есть
function detectWebPage(text?: string) {
  if (!text) return undefined;
  const match = text.match(URL_REGEX);
  if (!match) return undefined;
  const url = match[0];
  try {
    return { url, site_name: new URL(url).hostname };
  } catch {
    return undefined;
  }
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
