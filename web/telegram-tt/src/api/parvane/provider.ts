// Провайдер Parvane: тот же интерфейс, что у `gramjs/worker/connector`
// (initApi/callApi + поток ApiUpdate), но вместо MTProto — шина Parvane через
// gateway (WebSocket, JSON-кадры). Работает в главном потоке, без воркера.

import type { SendMessageParams, ThreadReadState } from '../../types';
import type { MethodArgs, MethodResponse, Methods } from '../gramjs/methods/types';
import type {
  ApiChat, ApiInitialArgs,
  ApiMessage,
  ApiOnProgress,
  ApiSticker, ApiThreadInfo,
  ApiUpdate,
  ApiUser,
  ApiUserStatus,
  ApiVideo,
  OnApiUpdate } from '../types';
import type { CallMedia, WireCallSignal } from './callengine';
import type {
  WireEvent, WireGroupInfo, WireMessageContent, WireStoredMessage, WireUserInfo,
} from './wire';
import { MAIN_THREAD_ID } from '../types';

import { decryptBlob, encryptBlob } from './blobcrypt';
import { CallEngine } from './callengine';
import { E2eEngine } from './e2e';
import {
  deliverToEveryGroupMember,
  E2E_SEND_ERROR,
  requireE2e,
  requireEncrypted,
} from './e2eSendPolicy';
import { apiEntitiesToWire } from './entities';
import { GatewayConnection, getGatewayUrl } from './gateway';
import { buildBuiltinGifs } from './gifs';
import { buildOldLangPack } from './oldLangPack';
import { PollStore } from './polls';
import { buildBuiltinCustomEmojiSet, buildBuiltinStickerSet, getStickerBlobMime } from './stickers';
import { buildWebPage, ParvaneStore } from './store';
import {
  buildCallInboxTopic,
  buildMsgInboxTopic,
  buildWireEvent,
  TOPIC_CALL_SIGNAL,
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
} from './wire';

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
  syncTimer = window.setInterval(() => {
    void runDeltaSync();
  }, DELTA_SYNC_INTERVAL_MS);
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
      remoteStream?: MediaStream; peerName?: string;
    };
  };
  w.parvaneCall = { state: 'ended' };
  const emit = () => window.dispatchEvent(new CustomEvent('parvane-call'));
  callListeners.onState = (state) => {
    w.parvaneCall!.state = state;
    if (state === 'ended') w.parvaneCall!.incoming = undefined;
    emit();
  };
  callListeners.onRemoteStream = (stream) => {
    w.parvaneCall!.remoteStream = stream;
    emit();
  };
  callListeners.onIncoming = (from, callId, media) => {
    w.parvaneCall!.incoming = { from, callId, media };
    w.parvaneCall!.state = 'incoming';
    w.parvaneCall!.peerName = store.getDisplayName(from);
    emit();
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

// Раздаёт session_key группы каждому текущему участнику 1-на-1 sealed (SKDM).
// Любой недоставленный ключ отменяет всё сообщение: частичная рассылка не
// должна провоцировать plaintext fallback или нечитаемое групповое сообщение.
async function distributeGroupKey(group: string, members: string[]) {
  const engine = requireE2e(e2e);
  const { sessionKey, epoch } = engine.getGroupSessionKey(group);
  const skdmContent = {
    kind: 'skdm', group, session_key: sessionKey, sender_identity: engine.identityKey, epoch,
  };
  const innerJson = JSON.stringify({ from: store.self, content: skdmContent });

  await deliverToEveryGroupMember(members, store.self, async (member) => {
    const encrypted = await engine.encryptFor(member, innerJson, fetchPrekeyBundle);
    if (!encrypted) return false;
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
    return true;
  });
}

// Публикует произвольный inner-content с тем же E2E-выбором, что sendMessage:
// группа → SKDM + group_encrypted; личка → sealed; иначе открыто. Для служебных
// сообщений опросов (poll/poll_vote/poll_close). Возвращает uuid отправленного
// ── GIF ──────────────────────────────────────────────────────────────────────

const savedGifs: ApiVideo[] = [];

function rememberSavedGif(gif: ApiVideo) {
  if (!savedGifs.some((g) => g.id === gif.id)) savedGifs.unshift(gif);
}

async function sendGif(chat: ApiChat, gif: ApiVideo) {
  const toAddress = store.getAddressForId(chat.id);
  if (!toAddress) return;
  requireE2e(e2e);
  const cached = await mediaCacheByFileId.get(gif.id);
  const blob = cached?.blob || (gif.blobUrl ? await fetch(gif.blobUrl).then((r) => r.blob()) : undefined);
  if (!blob) return;

  const { fileId, mediaKeys } = await uploadBlobToCloud(blob, `${gif.id}.webm`, 'video/webm', true);
  const mediaCrypto = mediaKeys ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64 } : {};

  const wireContent: Record<string, unknown> = {
    kind: 'gif',
    file_id: fileId,
    filename: `${gif.id}.webm`,
    mime: 'video/webm',
    width: gif.width || 240,
    height: gif.height || 240,
    duration_secs: Math.round(gif.duration),
    size_bytes: blob.size,
    ...mediaCrypto,
  };
  mediaCacheByFileId.set(fileId, Promise.resolve({ blob, mimeType: 'video/webm' }));

  const uuid = await publishInner(toAddress, wireContent);
  const id = store.allocateMessageId(chat.id, uuid);
  const sentGif = { ...gif, id: fileId };
  rememberSavedGif(sentGif);
  const message: ApiMessage = {
    id,
    chatId: chat.id,
    content: { video: sentGif },
    date: Math.floor(Date.now() / 1000),
    isOutgoing: true,
    senderId: selfId(),
  };
  store.putMessage(message);
  sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
}

// ── запланированные сообщения ────────────────────────────────────────────────
// Очередь живёт у клиента: текстовые записи переживают перезагрузку
// (localStorage), медиа-записи держим в памяти сессии. По сроку — обычная
// отправка через sendMessage + перенос из scheduled в чат

type ScheduledEntry = {
  id: number;
  chatId: string;
  scheduledAt: number;
  text?: string;
  entities?: SendMessageParams['entities'];
  replyToMsgId?: number;
  // Полные параметры (медиа/опрос/стикер) — только на время сессии
  params?: SendMessageParams;
};

const SCHEDULED_CHECK_INTERVAL_MS = 5000;
const SCHEDULED_ID_BASE = 1_000_001;

const scheduledQueue: ScheduledEntry[] = [];
let isScheduledLoaded = false;
let scheduledNextId = SCHEDULED_ID_BASE;

function loadScheduledQueue() {
  if (isScheduledLoaded || !store.self) return;
  isScheduledLoaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(`parvane:scheduled:${store.self}`) || '[]') as ScheduledEntry[];
    scheduledQueue.push(...raw);
    scheduledNextId = Math.max(scheduledNextId, ...raw.map((e) => e.id + 1));
  } catch { /* пустая очередь */ }
}

function persistScheduledQueue() {
  const persistable = scheduledQueue.filter((e) => !e.params);
  localStorage.setItem(`parvane:scheduled:${store.self}`, JSON.stringify(persistable));
}

function buildScheduledApiMessage(entry: ScheduledEntry): ApiMessage {
  const content = entry.params
    ? buildLocalContent(crypto.randomUUID(), entry.params)
    : { text: { text: entry.text || '', entities: entry.entities } };
  return {
    id: entry.id,
    chatId: entry.chatId,
    content,
    date: entry.scheduledAt,
    isOutgoing: true,
    senderId: selfId(),
    isScheduled: true,
    replyInfo: entry.replyToMsgId ? { type: 'message', replyToMsgId: entry.replyToMsgId } : undefined,
  };
}

function rebuildChatForScheduled(chatId: string): ApiChat | undefined {
  const address = store.getAddressForId(chatId);
  if (!address) return undefined;
  const groupInfo = store.getGroupInfo(address);
  return groupInfo ? store.buildApiChatForGroup(groupInfo) : store.buildApiChatForUser(address);
}

function removeScheduled(chatId: string, ids: number[]) {
  ids.forEach((id) => {
    const i = scheduledQueue.findIndex((e) => e.id === id && e.chatId === chatId);
    if (i >= 0) scheduledQueue.splice(i, 1);
  });
  persistScheduledQueue();
  sendUpdate({ '@type': 'deleteScheduledMessages', ids, chatId });
}

async function fireScheduled(entry: ScheduledEntry) {
  const chat = entry.params?.chat || rebuildChatForScheduled(entry.chatId);
  removeScheduled(entry.chatId, [entry.id]);
  if (!chat) return;
  const params: SendMessageParams = entry.params
    ? { ...entry.params, scheduledAt: undefined }
    : {
      chat,
      text: entry.text,
      entities: entry.entities,
      replyInfo: entry.replyToMsgId ? { type: 'message', replyToMsgId: entry.replyToMsgId } : undefined,
    };
  await methods.sendMessage(params);
}

function scheduleMessage(params: SendMessageParams) {
  loadScheduledQueue();
  const chat = params.chat!;
  const hasMedia = Boolean(params.attachment || params.sticker || params.gif || params.poll);
  const entry: ScheduledEntry = {
    id: scheduledNextId++,
    chatId: chat.id,
    scheduledAt: params.scheduledAt!,
    text: params.text,
    entities: params.entities,
    replyToMsgId: params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined,
    params: hasMedia ? { ...params } : undefined,
  };
  scheduledQueue.push(entry);
  persistScheduledQueue();
  sendUpdate({
    '@type': 'newScheduledMessage',
    chatId: chat.id,
    id: entry.id,
    message: buildScheduledApiMessage(entry),
  });
}

async function checkDueScheduled() {
  if (!store.self || !token) return;
  loadScheduledQueue();
  const now = Math.floor(Date.now() / 1000);
  const due = scheduledQueue.filter((e) => e.scheduledAt <= now);
  for (const entry of due) {
    await fireScheduled(entry);
  }
}

window.setInterval(() => {
  void checkDueScheduled();
}, SCHEDULED_CHECK_INTERVAL_MS);

// ── стикеры ──────────────────────────────────────────────────────────────────

async function sendSticker(chat: ApiChat, sticker: ApiSticker) {
  const toAddress = store.getAddressForId(chat.id);
  if (!toAddress) return;
  requireE2e(e2e);

  // Берём картинку/видео стикера из media-кэша (встроенный набор) или качаем
  const cached = await mediaCacheByFileId.get(sticker.id);
  const blob = cached?.blob;
  if (!blob) return;
  const mime = cached.mimeType || 'image/png';
  const ext = mime === 'video/webm' ? 'webm' : 'png';

  const { fileId, mediaKeys } = await uploadBlobToCloud(
    blob, `sticker-${sticker.id}.${ext}`, mime, true,
  );
  const mediaCrypto = mediaKeys ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64 } : {};

  const wireContent: Record<string, unknown> = {
    kind: 'sticker',
    file_id: fileId,
    filename: sticker.emoji || '⭐',
    mime,
    width: sticker.width || 256,
    height: sticker.height || 256,
    ...mediaCrypto,
  };
  mediaCacheByFileId.set(fileId, Promise.resolve({ blob, mimeType: mime }));

  const uuid = await publishInner(toAddress, wireContent);
  const id = store.allocateMessageId(chat.id, uuid);
  const message: ApiMessage = {
    id,
    chatId: chat.id,
    content: { sticker: { ...sticker, id: fileId } },
    date: Math.floor(Date.now() / 1000),
    isOutgoing: true,
    senderId: selfId(),
  };
  store.putMessage(message);
  sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
}

// ── опросы ───────────────────────────────────────────────────────────────────

async function sendPoll(chat: ApiChat, newPoll: {
  summary: {
    question: { text: string };
    answers: { text: { text: string } }[];
    isPublic?: true;
    isMultipleChoice?: true;
  };
}) {
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
  const engine = requireE2e(e2e);
  const groupInfo = store.getGroupInfo(toAddress);

  if (groupInfo) {
    await distributeGroupKey(toAddress, groupInfo.members.map((m) => m.address));
    const ciphertext = requireEncrypted(
      engine.groupEncrypt(toAddress, JSON.stringify(wireContent)),
      `Group encryption failed for ${toAddress}.`,
    );
    connection!.publish(TOPIC_MSG_SEND, JSON.stringify({
      id: uuid,
      from: store.self,
      ts,
      token,
      payload: {
        to: toAddress,
        content: {
          kind: 'group_encrypted', ciphertext, group: toAddress, sender_identity: engine.identityKey,
        },
      },
    }));
    appendOwnJournal({ id: uuid, from: store.self, to: toAddress, content: wireContent as never, ts });
    engine.cacheInner(uuid, { from: store.self, content: wireContent });
    return uuid;
  }

  const inner = JSON.stringify({ from: store.self, content: wireContent });
  const encrypted = requireEncrypted(
    await engine.encryptFor(toAddress, inner, fetchPrekeyBundle),
    `No usable prekey/session for ${toAddress}.`,
  );
  connection!.publish(TOPIC_MSG_SEND, JSON.stringify({
    id: uuid,
    from: '',
    ts,
    token,
    payload: {
      to: toAddress,
      content: {
        kind: 'encrypted',
        ciphertext: encrypted.ciphertext,
        ctype: encrypted.ctype,
        sender_identity: encrypted.sender_identity,
      },
    },
  }));
  appendOwnJournal({ id: uuid, from: store.self, to: toAddress, content: wireContent as never, ts });
  engine.cacheInner(uuid, { from: store.self, content: wireContent });
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
  // Полученные GIF пополняют Saved GIFs (как в Telegram)
  if (stored.content.kind === 'gif' && message.content.video) {
    rememberSavedGif(message.content.video);
  }

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

function reportEncryptionSendFailure(chatId: string, localId: number, detail?: unknown) {
  const detailMessage = detail instanceof Error ? detail.message : '';
  logDebug(`${E2E_SEND_ERROR}${detailMessage ? ` ${detailMessage}` : ''}`);
  sendUpdate({
    '@type': 'updateMessageSendFailed',
    chatId,
    localId,
    error: E2E_SEND_ERROR,
  });
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
    // Пинок загрузки наборов стикеров/кастом-эмодзи после маунта Main: штатный
    // путь гейтится на isAppConfigLoaded (fetchAppConfig у нас нет), а апдейт
    // updateStickerSets зовёт loadStickerSets напрямую
    setTimeout(() => sendUpdate({ '@type': 'updateStickerSets' }), 0);

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
    const { chat, replyInfo } = params;
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
    // Запланированное: в локальную очередь, по сроку — обычная отправка
    if (params.scheduledAt && params.chat) {
      scheduleMessage(params);
      return;
    }
    // Опрос: отдельный поток (kind=poll едет в E2E; агрегация голосов локальна)
    if (params.poll && params.chat) {
      await sendPoll(params.chat, params.poll);
      return;
    }
    // Стикер: грузим картинку как медиа с kind=sticker (реюз attachment-потока)
    if (params.sticker && params.chat) {
      await sendSticker(params.chat, params.sticker);
      return;
    }
    // GIF (анимированный webm)
    if (params.gif && params.chat) {
      await sendGif(params.chat, params.gif);
      return;
    }

    const localMessage = params.localMessage
      || await methods.sendMessageLocal(params);
    const { chat, attachment } = params;
    if (!localMessage || !chat) return;

    const toAddress = store.getAddressForId(chat.id);
    if (!toAddress) return;

    let engine: E2eEngine;
    try {
      engine = requireE2e(e2e);
    } catch (err) {
      reportEncryptionSendFailure(chat.id, localMessage.id, err);
      return;
    }

    const uuid = uuidBySentLocalKey.get(`${chat.id}:${localMessage.id}`) || crypto.randomUUID();
    const replyToMsgId = params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined;
    const replyToUuid = replyToMsgId ? store.getUuidForMessage(chat.id, replyToMsgId) : undefined;

    // Блоб шифруется всегда. Ошибка E2E выше завершает отправку до upload, так
    // что cloud никогда не получает plaintext из автоматического fallback.
    const shouldEncryptMedia = true;

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
    const groupInfo = store.getGroupInfo(toAddress);
    if (groupInfo) {
      try {
        await distributeGroupKey(toAddress, groupInfo.members.map((m) => m.address));
        const ciphertext = requireEncrypted(
          engine.groupEncrypt(toAddress, JSON.stringify(wireContent)),
          `Group encryption failed for ${toAddress}.`,
        );
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
              sender_identity: engine.identityKey,
            },
            reply_to: replyToUuid,
          },
        };
        connection!.publish(TOPIC_MSG_SEND, JSON.stringify(groupEvent));
        // Своё групповое эхо не вернётся расшифрованным (from=self, но
        // ciphertext) — журналим плейнтекст и кэшируем
        appendOwnJournal({
          id: uuid,
          from: store.self,
          to: toAddress,
          content: wireContent as unknown as WireMessageContent,
          ts,
          reply_to: replyToUuid,
        });
        engine.cacheInner(uuid, { from: store.self, content: wireContent });
        const sentMessage: ApiMessage = { ...localMessage, sendingState: undefined };
        store.putMessage(sentMessage);
        sendUpdate({
          '@type': 'updateMessageSendSucceeded', chatId: chat.id, localId: localMessage.id, message: sentMessage,
        });
        return;
      } catch (err) {
        reportEncryptionSendFailure(chat.id, localMessage.id, err);
        return;
      }
    }

    // E2E sealed sender: весь content (текст ИЛИ медиа-метаданные с file_key)
    // шифруется Olm — сервер не видит ни содержимого, ни отправителя.
    const plainContent = wireContent;
    try {
      const innerJson = JSON.stringify({ from: store.self, content: wireContent });
      const encrypted = requireEncrypted(
        await engine.encryptFor(toAddress, innerJson, fetchPrekeyBundle),
        `No usable prekey/session for ${toAddress}.`,
      );
      wireContent = {
        kind: 'encrypted',
        ciphertext: encrypted.ciphertext,
        ctype: encrypted.ctype,
        sender_identity: encrypted.sender_identity,
      };
    } catch (err) {
      reportEncryptionSendFailure(chat.id, localMessage.id, err);
      return;
    }

    const ts = Math.floor(Date.now() / 1000);
    const event = {
      id: uuid,
      from: '',
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
    if (!ttlSecs) {
      // Сервер не отдаст отправителю его sealed — журналим локально
      appendOwnJournal({
        id: uuid,
        from: store.self,
        to: toAddress,
        content: plainContent as unknown as WireMessageContent,
        ts,
        reply_to: replyToUuid,
      });
      engine.cacheInner(uuid, { from: store.self, content: plainContent });
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

  // Пересылка = независимая копия content в другой чат с меткой forwarded_from
  async forwardMessages({ fromChat, toChat, messages: fwdMessages }: {
    fromChat: ApiChat; toChat: ApiChat; messages: ApiMessage[];
  }) {
    const toAddress = store.getAddressForId(toChat.id);
    if (!toAddress) return undefined;
    const fromAddress = store.getAddressForId(fromChat.id) || '';

    for (const msg of fwdMessages) {
      const wireContent = apiMessageToWireContent(msg);
      if (!wireContent) continue;
      const origSender = msg.senderId ? store.getAddressForId(msg.senderId) : fromAddress;
      wireContent.forwarded_from = origSender || fromAddress;
      wireContent.forwarded_name = origSender ? store.getDisplayName(origSender) : store.getDisplayName(fromAddress);

      const uuid = await publishInner(toAddress, wireContent);
      const id = store.allocateMessageId(toChat.id, uuid);
      const localMessage: ApiMessage = {
        id,
        chatId: toChat.id,
        content: msg.content,
        date: Math.floor(Date.now() / 1000),
        isOutgoing: true,
        senderId: selfId(),
        forwardInfo: {
          date: msg.date,
          isChannelPost: false,
          fromChatId: origSender ? store.getIdForAddress(origSender) : undefined,
          hiddenUserName: wireContent.forwarded_name as string,
        },
      };
      store.putMessage(localMessage);
      sendUpdate({ '@type': 'newMessage', chatId: toChat.id, id, message: localMessage });
    }
    return true;
  },

  // ── блокировка (локальный персист — у Parvane нет серверного блока) ─────────
  blockUser({ user }: { user: ApiUser }) {
    const address = store.getAddressForId(user.id);
    if (address) {
      const blocked = loadBlocked();
      if (!blocked.includes(address)) {
        blocked.push(address);
        saveBlocked(blocked);
      }
    }
    return Promise.resolve(true);
  },

  unblockUser({ user }: { user: ApiUser }) {
    const address = store.getAddressForId(user.id);
    if (address) saveBlocked(loadBlocked().filter((a) => a !== address));
    return Promise.resolve(true);
  },

  fetchBlockedUsers() {
    const ids = loadBlocked().map((a) => store.getIdForAddress(a));
    return Promise.resolve({ blockedIds: ids, totalCount: ids.length });
  },

  // «Кто голосовал» в опросе (публичные): список проголосовавших за вариант
  loadPollOptionResults({ chat, messageId, option }: {
    chat: ApiChat; messageId: number; option?: string;
  }) {
    const uuid = store.getUuidForMessage(chat.id, messageId);
    if (!uuid || option === undefined) return Promise.resolve(undefined);
    const voters = polls.getVoters(uuid, Number(option));
    const votes = voters.map((address) => ({
      peerId: store.getIdForAddress(address),
      date: Math.floor(Date.now() / 1000),
    }));
    return Promise.resolve({ count: votes.length, votes, nextOffset: undefined });
  },

  // ── папки (локальный персист, как в десктоп-форке) ──────────────────────────
  fetchChatFolders() {
    const folders = loadFolders();
    const byId: Record<number, unknown> = {};
    const orderedIds: number[] = [0]; // 0 = All chats
    folders.forEach((folder) => {
      byId[folder.id] = folder;
      orderedIds.push(folder.id);
    });
    return Promise.resolve({ byId, orderedIds, recommended: undefined });
  },

  editChatFolder({ id, folderUpdate }: { id: number; folderUpdate: Record<string, unknown> }) {
    const folders = loadFolders().filter((f) => f.id !== id);
    folders.push({ ...folderUpdate, id });
    saveFolders(folders);
    return Promise.resolve(true);
  },

  deleteChatFolder(id: number) {
    saveFolders(loadFolders().filter((f) => f.id !== id));
    return Promise.resolve(true);
  },

  async parvaneSendLocation({ chat, lat, long }: { chat: ApiChat; lat: number; long: number }) {
    const toAddress = store.getAddressForId(chat.id);
    if (!toAddress) return undefined;
    const uuid = await publishInner(toAddress, { kind: 'location', lat, long });
    const id = store.allocateMessageId(chat.id, uuid);
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: { location: { mediaType: 'geo', geo: { lat, long, accessHash: '0' } } },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: selfId(),
    };
    store.putMessage(message);
    sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
    return true;
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

  // ── стикеры (встроенный набор) ──────────────────────────────────────────────
  async fetchStickerSets() {
    const { set, blobs } = await buildBuiltinStickerSet();
    // Регистрируем картинки/видео стикеров в media-кэше (хэш document<id>)
    blobs.forEach((blob, id) => {
      if (!mediaCacheByFileId.has(id)) {
        mediaCacheByFileId.set(id, Promise.resolve({ blob, mimeType: getStickerBlobMime(id) }));
      }
    });
    return { hash: '1', sets: [{ ...set, stickers: undefined, count: set.count }] };
  },

  async fetchStickerSet(params?: { stickerSetInfo?: { id?: string; shortName?: string } }) {
    const wantsEmoji = params?.stickerSetInfo?.id === 'parvane-emoji'
      || params?.stickerSetInfo?.shortName === 'ParvaneEmoji';
    const { set, blobs } = wantsEmoji ? await buildBuiltinCustomEmojiSet() : await buildBuiltinStickerSet();
    blobs.forEach((blob, id) => {
      if (!mediaCacheByFileId.has(id)) {
        mediaCacheByFileId.set(id, Promise.resolve({ blob, mimeType: getStickerBlobMime(id) }));
      }
    });
    return { set, stickers: set.stickers };
  },

  async fetchStickers(params?: { stickerSetInfo?: { id?: string; shortName?: string } }) {
    const result = await methods.fetchStickerSet(params);
    const packs: Record<string, ApiSticker[]> = {};
    (result.stickers || []).forEach((s) => {
      if (s.emoji) (packs[s.emoji] ||= []).push(s);
    });
    return { set: result.set, stickers: result.stickers || [], packs };
  },

  async fetchRecentStickers() {
    const { set } = await buildBuiltinStickerSet();
    return { hash: '1', stickers: (set.stickers || []).slice(0, 6) };
  },

  fetchFeaturedStickers() {
    return Promise.resolve({ hash: '1', sets: [] });
  },

  // ── кастом-эмодзи (встроенный набор) ────────────────────────────────────────

  async fetchCustomEmojiSets() {
    const { set, blobs } = await buildBuiltinCustomEmojiSet();
    blobs.forEach((blob, id) => {
      if (!mediaCacheByFileId.has(id)) {
        mediaCacheByFileId.set(id, Promise.resolve({ blob, mimeType: 'image/png' }));
      }
    });
    return { hash: '1', sets: [set] };
  },

  async fetchCustomEmoji({ documentId }: { documentId: string[] }) {
    const { set, blobs } = await buildBuiltinCustomEmojiSet();
    blobs.forEach((blob, id) => {
      if (!mediaCacheByFileId.has(id)) {
        mediaCacheByFileId.set(id, Promise.resolve({ blob, mimeType: 'image/png' }));
      }
    });
    return (set.stickers || []).filter((s) => documentId.includes(s.id));
  },

  async fetchSavedGifs() {
    const { gifs, blobs } = await buildBuiltinGifs();
    blobs.forEach((blob, id) => {
      if (!mediaCacheByFileId.has(id)) {
        mediaCacheByFileId.set(id, Promise.resolve({ blob, mimeType: 'video/webm' }));
      }
    });
    return { hash: '1', gifs: [...gifs, ...savedGifs] };
  },

  // ── запланированные сообщения (локальная очередь) ───────────────────────────

  fetchScheduledHistory({ chat }: { chat: ApiChat }) {
    loadScheduledQueue();
    const messages = scheduledQueue
      .filter((e) => e.chatId === chat.id)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map(buildScheduledApiMessage);
    return Promise.resolve({ messages });
  },

  deleteScheduledMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
    loadScheduledQueue();
    removeScheduled(chat.id, messageIds);
    return Promise.resolve();
  },

  async sendScheduledMessages({ chat, ids }: { chat: ApiChat; ids: number[] }) {
    loadScheduledQueue();
    for (const id of ids) {
      const entry = scheduledQueue.find((e) => e.chatId === chat.id && e.id === id);
      if (entry) await fireScheduled(entry);
    }
  },

  rescheduleMessage({ chat, message, scheduledAt }: { chat: ApiChat; message: ApiMessage; scheduledAt: number }) {
    loadScheduledQueue();
    const entry = scheduledQueue.find((e) => e.chatId === chat.id && e.id === message.id);
    if (!entry) return Promise.resolve();
    entry.scheduledAt = scheduledAt;
    persistScheduledQueue();
    sendUpdate({
      '@type': 'updateScheduledMessage',
      chatId: chat.id,
      id: entry.id,
      message: buildScheduledApiMessage(entry),
    });
    return Promise.resolve();
  },

  // ── звонки (программный API; UI-панель — window.parvaneCalls) ───────────────
  async parvanePlaceCall({ chat, isVideo }: { chat: ApiChat; isVideo?: boolean }) {
    const toAddress = store.getAddressForId(chat.id);
    if (!toAddress || !callEngine || store.isGroupAddress(toAddress)) return undefined;
    const callState = (window as unknown as { parvaneCall?: { peerName?: string } }).parvaneCall!;
    callState.peerName = store.getDisplayName(toAddress);
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
    users.forEach((user) => {
      userStatusesById[user.id] = RECENT_STATUS;
    });
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
    bytes = enc.ciphertext;
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
  return { blob: new Blob(parts, { type: mimeType }), mimeType };
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

const MEDIA_URL_REGEX = /^(?:photo|document)([\w-]+?)(?:\?|$)/;
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

// Пересобирает wire-content из ApiMessage (для пересылки). Медиа-ключи берём
// из реестра (file_id → key/nonce), чтобы получатель расшифровал
function apiMessageToWireContent(msg: ApiMessage): Record<string, unknown> | undefined {
  const c = msg.content;
  if (c.text && !c.photo && !c.document && !c.sticker) {
    return {
      kind: 'text',
      text: c.text.text,
      entities: apiEntitiesToWire(c.text.entities),
    };
  }
  const mediaId = c.photo?.id || c.document?.id || c.sticker?.id || c.video?.id;
  if (!mediaId) return undefined;
  const keys = mediaKeysByFileId.get(mediaId);
  const crypto = keys ? { file_key: keys.keyB64, file_nonce: keys.nonceB64 } : {};
  if (c.video?.isGif) {
    return {
      kind: 'gif',
      file_id: mediaId,
      filename: c.video.fileName,
      mime: c.video.mimeType,
      width: c.video.width || 240,
      height: c.video.height || 240,
      duration_secs: Math.round(c.video.duration),
      size_bytes: c.video.size,
      ...crypto,
    };
  }
  if (c.sticker) {
    return {
      kind: 'sticker', file_id: mediaId, filename: c.sticker.emoji || '⭐', mime: 'image/png', ...crypto,
    };
  }
  if (c.photo) {
    return {
      kind: 'photo', file_id: mediaId, width: 0, height: 0, mime: 'image/jpeg', ...crypto,
    };
  }
  return {
    kind: 'file',
    file_id: mediaId,
    filename: c.document!.fileName,
    mime: c.document!.mimeType,
    size_bytes: c.document!.size,
    ...crypto,
  };
}

// Блокировка хранится локально (у Parvane нет серверного блока)
function loadBlocked(): string[] {
  try {
    return JSON.parse(localStorage.getItem(`parvane:blocked:${store.self}`) || '[]');
  } catch {
    return [];
  }
}

function saveBlocked(list: string[]) {
  localStorage.setItem(`parvane:blocked:${store.self}`, JSON.stringify(list));
}

// Папки хранятся локально (у Parvane нет облачных фильтров)
function loadFolders(): { id: number; [k: string]: unknown }[] {
  try {
    return JSON.parse(localStorage.getItem(`parvane:folders:${store.self}`) || '[]');
  } catch {
    return [];
  }
}

function saveFolders(folders: { id: number; [k: string]: unknown }[]) {
  localStorage.setItem(`parvane:folders:${store.self}`, JSON.stringify(folders));
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
    if (!reportedMissingMethods.has(fnName)) {
      reportedMissingMethods.add(fnName);
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
