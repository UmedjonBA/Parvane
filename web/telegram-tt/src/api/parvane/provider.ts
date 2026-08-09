// Провайдер Parvane: тот же интерфейс, что у `gramjs/worker/connector`
// (initApi/callApi + поток ApiUpdate), но вместо MTProto — шина Parvane через
// gateway (WebSocket, JSON-кадры). Работает в главном потоке, без воркера.

import type { SendMessageParams, ThreadReadState } from '../../types';
import type { MethodArgs, MethodResponse, Methods } from '../gramjs/methods/types';
import type {
  ApiAppConfig,
  ApiAvailableReaction,
  ApiChat, ApiDraft, ApiInitialArgs,
  ApiMessage,
  ApiOnProgress,
  ApiSticker, ApiThreadInfo,
  ApiUpdate,
  ApiUser,
  ApiUserStatus,
  ApiVideo,
  OnApiUpdate } from '../types';
import type { GatewayConnection } from './gateway';
import type { PackFile, StoredPack } from './stickerPacks';
import type { WireUserInfo } from './wire';
import { MAIN_THREAD_ID } from '../types';

import { ARCHIVED_FOLDER_ID } from '../../config';
import { DEFAULT_APP_CONFIG } from '../../limits';
import {
  clearLoginStorage,
  consumeLegacyCredentials,
  parseLoginCredentials,
  readLoginAddress,
  saveLoginAddress,
} from './authStorage';
import { createCallController } from './calls';
import { createConnectionController } from './connectionController';
import { E2eEngine } from './e2e';
import { buildBuiltinGifs } from './gifs';
import { createGroupController } from './groups';
import { createLocalState } from './localState';
import { createMediaService } from './media';
import { createMessageController } from './messages';
import { buildOldLangPack } from './oldLangPack';
import { PollStore } from './polls';
import {
  buildApiStickerSetFromPack,
  findInstalledPackBySetId,
  getPackFileMime,
  getPendingFiles,
  getReceivedPackRef,
  isCustomPackSetId,
  loadInstalledPacks,
  parsePvpkArchive,
  removeInstalledPack,
  resetPackRegistries,
  resolveSetIdByShortName,
  sanitizePackName,
  saveInstalledPack,
  setPendingFiles,
} from './stickerPacks';
import { buildBuiltinCustomEmojiSet, buildBuiltinStickerSet, getStickerBlobMime } from './stickers';
import { ParvaneStore } from './store';
import { createSyncController } from './sync';
import {
  TOPIC_IDENTITY_SEARCH,
  TOPIC_IDENTITY_SETAVATAR,
  TOPIC_IDENTITY_SETNAME,
  TOPIC_PUSH_REGISTER,
  TOPIC_PUSH_UNREGISTER,
  TOPIC_PUSH_VAPID_GET,
} from './wire';

const LOGIN_HASH_PREFIX = '#parvane=';
const PARVANE_APP_CONFIG: ApiAppConfig = { ...DEFAULT_APP_CONFIG, hash: 1 };
const BUILTIN_REACTIONS: ApiAvailableReaction[] = [
  '👍', '❤️', '🔥', '😂', '👏', '🎉', '🤔',
].map((emoticon) => ({
  reaction: { type: 'emoji', emoticon },
  title: emoticon,
}));

let onUpdate: OnApiUpdate = () => undefined;
let startupCredentials = consumeStartupCredentials();
let connection: GatewayConnection | undefined;
let store = new ParvaneStore();
let token = '';
let pendingLoginAddress = '';
let e2e: E2eEngine | undefined;
let isCallIdentityReady = false;
const polls = new PollStore();

const reportedMissingMethods = new Set<string>();

// Инициализируется после syncController: оба сервиса связаны только callback-ами.
// eslint-disable-next-line prefer-const
let messageController: ReturnType<typeof createMessageController>;

function refreshPollMessageFromSync(uuid: string) {
  messageController.refreshPollMessage(uuid);
}

function rememberSavedGifFromSync(gif: ApiVideo) {
  messageController.rememberSavedGif(gif);
}

async function sendMessageFromSchedule(params: SendMessageParams): Promise<unknown> {
  return methods.sendMessage(params);
}

const mediaService = createMediaService({
  getConnection: () => connection,
  getStore: () => store,
  getToken: () => token,
});

const callController = createCallController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  isIdentityReady: () => isCallIdentityReady,
  sendUpdate,
  log: logDebug,
});

const groupController = createGroupController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  selfId,
  sendUpdate,
  log: logDebug,
});

const localState = createLocalState({
  getStore: () => store,
  isAuthorized: () => Boolean(token),
  selfId,
  sendUpdate,
  buildLocalContent: mediaService.buildLocalContent,
  sendMessage: sendMessageFromSchedule,
});

// Кросс-таб синхронизация черновиков: другая вкладка сохранила/очистила
// черновик — применяем у себя без обращения к серверу
const draftsChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('parvane:drafts')
  : undefined;
if (draftsChannel) {
  draftsChannel.onmessage = (event: MessageEvent) => {
    const { address, draft } = event.data as { address: string; draft?: Record<string, unknown> };
    localState.saveDraft(address, draft);
    sendUpdate({
      '@type': 'draftMessage',
      chatId: store.getIdForAddress(address),
      threadId: MAIN_THREAD_ID,
      draft: draft as ApiDraft | undefined,
    });
  };
}

const syncController = createSyncController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  groups: groupController,
  localState,
  media: mediaService,
  polls,
  refreshPollMessage: refreshPollMessageFromSync,
  rememberSavedGif: rememberSavedGifFromSync,
  sendUpdate,
  log: logDebug,
});

messageController = createMessageController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  localState,
  media: mediaService,
  polls,
  sync: syncController,
  selfId,
  sendUpdate,
  collectUsersFor,
  clearPersistedDraft: (address: string) => {
    localState.saveDraft(address, undefined);
    draftsChannel?.postMessage({ address, draft: undefined });
  },
  log: logDebug,
});

const connectionController = createConnectionController({
  calls: callController,
  getConnection: () => connection,
  setConnection: (nextConnection) => { connection = nextConnection; },
  getE2e: () => e2e,
  setE2e: (nextE2e) => { e2e = nextE2e; },
  getStore: () => store,
  setStore: (nextStore) => { store = nextStore; },
  getToken: () => token,
  setToken: (nextToken) => { token = nextToken; },
  setCallIdentityReady: (isReady) => { isCallIdentityReady = isReady; },
  polls,
  onNewSession: () => {
    syncController.reset();
    resetPackRegistries();
    messageController.resetSavedGifs();
  },
  isSynced: syncController.isSynced,
  resetSyncPromise: syncController.resetPromise,
  requestDeltaSync: syncController.requestDeltaSync,
  resolveDisplayNames: syncController.resolveDisplayNames,
  handleInboxFrame: syncController.handleInboxFrame,
  selfId,
  sendUpdate,
  log: logDebug,
});

export async function initApi(_onUpdate: OnApiUpdate, _initialArgs: ApiInitialArgs) {
  onUpdate = _onUpdate;
  // eslint-disable-next-line no-console
  console.info('[parvane] initApi вызван');

  sendUpdate({ '@type': 'updateApiReady' });
  sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });

  const creds = startupCredentials;
  startupCredentials = undefined;
  if (!creds) {
    const savedAddress = readLoginAddress();
    if (savedAddress) {
      pendingLoginAddress = savedAddress;
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
      return;
    }
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
    return;
  }

  try {
    await connectionController.connectAndLogin(creds.user, creds.password);
    saveLoginAddress(creds.user);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[parvane] логин не удался:', err);
    pendingLoginAddress = creds.user;
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
    sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
  }
}

function logDebug(message: string) {
  // eslint-disable-next-line no-console
  console.info(`[parvane] ${message}`);
}

// ── методы (подмножество Methods, остальное — заглушки) ──────────────────────

const RECENT_STATUS: ApiUserStatus = { type: 'userStatusRecently' };
const INSTALLED_PACK_DATE = Math.floor(Date.now() / 1000);

function registerPackBlobs(blobs: Map<string, { blob: Blob; mime: string }>) {
  blobs.forEach(({ blob, mime }, id) => mediaService.cacheBlobIfAbsent(id, blob, mime));
}

// Файлы кастомного пака: установленный → из IndexedDB; открытый в модалке —
// из pending-кэша; иначе тянем PVPK1-архив из cloud по pack_ref
async function resolveCustomPack(setId: string): Promise<{ pack: StoredPack; isInstalled: boolean } | undefined> {
  const installed = await findInstalledPackBySetId(store.self, setId);
  if (installed) return { pack: installed, isInstalled: true };
  const pending = getPendingFiles(setId);
  if (pending) return { pack: pending, isInstalled: false };
  const ref = getReceivedPackRef(setId);
  if (!ref?.file_id) return undefined;
  if (ref.key && ref.nonce) {
    mediaService.rememberKeys({
      kind: 'sticker', file_id: ref.file_id, file_key: ref.key, file_nonce: ref.nonce,
    });
  }
  const media = await mediaService.downloadBlob(ref.file_id);
  if (!media) return undefined;
  const files = parsePvpkArchive(new Uint8Array(await media.blob.arrayBuffer()));
  if (!files) return undefined;
  const pack: StoredPack = { name: ref.name, files };
  setPendingFiles(setId, pack);
  return { pack, isInstalled: false };
}

const methods = {
  fetchAppConfig({ hash }: { hash?: number }) {
    return Promise.resolve(hash === PARVANE_APP_CONFIG.hash ? undefined : PARVANE_APP_CONFIG);
  },

  fetchAvailableReactions() {
    return Promise.resolve(BUILTIN_REACTIONS);
  },

  async fetchChats({ archived }: { archived?: boolean }) {
    await syncController.ensureSynced();
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

    // Черновики хранятся по адресу пира: восстанавливаем чат даже если пир ещё
    // не известен (истории нет), иначе черновик негде показать
    const savedDrafts = localState.loadDrafts();
    Object.keys(savedDrafts).forEach((address) => {
      const chatId = store.getIdForAddress(address);
      if (!chats.some((chat) => chat.id === chatId)) {
        const user = store.buildApiUser(address);
        users.push(user);
        chats.push(store.buildApiChatForUser(address));
      }
    });
    const chatIdsWithDrafts = new Set(
      Object.keys(savedDrafts).map((address) => store.getIdForAddress(address)),
    );

    const chatIdsWithHistory = new Set(store.getChatIds());
    const isVisibleChat = (chat: ApiChat) => chatIdsWithHistory.has(chat.id)
      || chatIdsWithDrafts.has(chat.id)
      || chat.type !== 'chatTypePrivate';
    const listedChats = chats.filter(
      (chat) => isVisibleChat(chat) || chat.id !== selfId(),
    );
    const allVisibleChats = listedChats.filter(isVisibleChat);

    // Архив и пины (локальный persist по адресу пира/группы)
    const archivedIds = new Set(
      localState.loadArchived().map((address) => store.getIdForAddress(address)),
    );
    allVisibleChats.forEach((chat) => {
      chat.folderId = archivedIds.has(chat.id) ? ARCHIVED_FOLDER_ID : undefined;
    });
    const visibleChats = allVisibleChats.filter(
      (chat) => (archived ? archivedIds.has(chat.id) : !archivedIds.has(chat.id)),
    );
    const pinnedIds = localState.loadPinned()
      .map((address) => store.getIdForAddress(address))
      .filter((id) => visibleChats.some((chat) => chat.id === id));
    const orderedPinnedIds = archived || !pinnedIds.length ? undefined : pinnedIds;

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
          if (uuid && syncController.getFlags(uuid)?.read) {
            if (message.id > lastReadInbox) lastReadInbox = message.id;
          } else {
            unreadCount += 1;
          }
        });
        if (isSelfChat) lastReadInbox = last.id;
        const unreadMentions = isSelfChat ? [] : syncController.collectUnreadMentions(chat.id);
        threadReadStatesById[chat.id] = {
          lastReadInboxMessageId: lastReadInbox,
          unreadCount,
          unreadMentionsCount: unreadMentions.length,
          unreadMentions,
          lastReadOutboxMessageId: syncController.getReadOutboxMax(chat.id),
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

    // Черновики из localStorage (ключ — адрес пира): восстанавливаются после
    // reload/перезахода. loadAllChats ждёт плоский chatId → ApiDraft
    const draftsById = Object.fromEntries(
      Object.entries(savedDrafts)
        .map(([address, draft]) => [store.getIdForAddress(address), draft])
        .filter(([chatId]) => visibleChats.some((chat) => chat.id === chatId)),
    );

    return {
      chatIds: visibleChats.map((chat) => chat.id),
      chats: visibleChats,
      users,
      userStatusesById,
      draftsById,
      threadReadStatesById,
      threadInfos,
      orderedPinnedIds,
      totalChatCount: visibleChats.length,
      messages,
      notifyExceptionById: {},
      lastMessageByChatId,
    };
  },

  async fetchMessages({ chat, limit }: { chat: ApiChat; limit: number }) {
    await syncController.ensureSynced();
    const history = store.getMessages(chat.id);
    const messages = history.slice(-Math.max(limit, 1) * 2);
    // Опросы: poll-объект не в content, доотдаём отдельными апдейтами после
    // того как сообщения окажутся в global (следующий тик)
    const pollMessages = messages.filter((m) => m.content.pollId);
    if (pollMessages.length) {
      window.setTimeout(() => {
        pollMessages.forEach((m) => (
          m.content.pollId && messageController.refreshPollMessage(m.content.pollId)
        ));
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

  ...messageController.methods,

  downloadMedia(
    { url, mediaFormat, start, end }: { url: string; mediaFormat: number; start?: number; end?: number },
    _onProgress?: ApiOnProgress,
  ) {
    return mediaService.downloadMedia({ url, mediaFormat, start, end });
  },

  // ── группы ─────────────────────────────────────────────────────────────────

  createGroupChat: groupController.createGroupChat,
  createChannel: groupController.createChannel,
  fetchFullChat: groupController.fetchFullChat,
  addChatMembers: groupController.addChatMembers,
  deleteChatMember: groupController.deleteChatMember,
  updateChatMemberBannedRights: groupController.updateChatMemberBannedRights,
  exportChatInvite: groupController.exportChatInvite,
  importChatInvite: groupController.importChatInvite,
  updateChatAdmin: groupController.updateChatAdmin,

  // ── пины и архив чатов (локальный persist) ──────────────────────────────────

  toggleChatPinned({ chat, shouldBePinned }: { chat: ApiChat; shouldBePinned: boolean }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve(undefined);
    localState.setPinned(address, shouldBePinned);
    sendUpdate({ '@type': 'updateChatPinned', id: chat.id, isPinned: shouldBePinned });
    return Promise.resolve(undefined);
  },

  toggleChatArchived({ chat, folderId }: { chat: ApiChat; folderId: number }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve(undefined);
    const isArchiving = folderId === ARCHIVED_FOLDER_ID;
    localState.setArchived(address, isArchiving);
    // Архивируемый чат снимается с пина
    if (isArchiving) localState.setPinned(address, false);
    sendUpdate({ '@type': 'updateChatListType', id: chat.id, folderId });
    return Promise.resolve(undefined);
  },

  // ── черновики (локальный persist + кросс-таб) ───────────────────────────────

  saveDraft({ chat, draft }: { chat: ApiChat; draft: Record<string, unknown> }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve({});
    localState.saveDraft(address, draft);
    draftsChannel?.postMessage({ address, draft });
    return Promise.resolve({});
  },

  clearDraft({ chatId }: { chatId: string }) {
    const address = store.getAddressForId(chatId);
    if (!address) return Promise.resolve(undefined);
    localState.saveDraft(address, undefined);
    draftsChannel?.postMessage({ address, draft: undefined });
    return Promise.resolve(undefined);
  },

  // ── упоминания ──────────────────────────────────────────────────────────────

  fetchUnreadMentions({ chat }: { chat: ApiChat }) {
    const ids = new Set(syncController.collectUnreadMentions(chat.id));
    const messages = store.getMessages(chat.id).filter((message) => ids.has(message.id));
    return Promise.resolve({ messages, totalCount: messages.length });
  },

  migrateChat: (chat: ApiChat) => Promise.resolve(groupController.migrateChat(chat)),

  updateChatTitle(chat: ApiChat, title: string) {
    return groupController.updateChatTitle(chat, title);
  },

  // Выход из группы/канала: на бэкенде это self-remove
  deleteChatUser({ chat }: { chat: ApiChat; user: ApiUser }) {
    return groupController.leaveGroup(chat.id);
  },

  leaveChannel({ chat }: { chat: ApiChat }) {
    return groupController.leaveGroup(chat.id);
  },

  deleteChat({ chatId }: { chatId: string }) {
    return groupController.deleteGroup(chatId);
  },

  deleteChannel({ channelId }: { channelId: string }) {
    return groupController.deleteGroup(channelId);
  },

  // ── блокировка (локальный персист — у Parvane нет серверного блока) ─────────
  blockUser({ user }: { user: ApiUser }) {
    const address = store.getAddressForId(user.id);
    if (address) {
      const blocked = localState.loadBlocked();
      if (!blocked.includes(address)) {
        blocked.push(address);
        localState.saveBlocked(blocked);
      }
    }
    return Promise.resolve(true);
  },

  unblockUser({ user }: { user: ApiUser }) {
    const address = store.getAddressForId(user.id);
    if (address) localState.saveBlocked(localState.loadBlocked().filter((a) => a !== address));
    return Promise.resolve(true);
  },

  fetchBlockedUsers() {
    const ids = localState.loadBlocked().map((a) => store.getIdForAddress(a));
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
    const folders = localState.loadFolders();
    const byId: Record<number, unknown> = {};
    const orderedIds: number[] = [0]; // 0 = All chats
    folders.forEach((folder) => {
      byId[folder.id] = folder;
      orderedIds.push(folder.id);
    });
    return Promise.resolve({ byId, orderedIds, recommended: undefined });
  },

  editChatFolder({ id, folderUpdate }: { id: number; folderUpdate: Record<string, unknown> }) {
    const folders = localState.loadFolders().filter((f) => f.id !== id);
    folders.push({ ...folderUpdate, id });
    localState.saveFolders(folders);
    return Promise.resolve(true);
  },

  deleteChatFolder(id: number) {
    localState.saveFolders(localState.loadFolders().filter((f) => f.id !== id));
    return Promise.resolve(true);
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
      syncController.announcePeer(u.username);
      globalResultIds.push(store.getIdForAddress(u.username));
    });
    return { accountResultIds: [], globalResultIds };
  },

  searchMessagesGlobal({ query }: { query?: string }) {
    return Promise.resolve(buildSearchResults(searchLocalMessages(query)));
  },

  searchMessagesInChat({ peer, query, type }: { peer: { id: string }; query?: string; type?: string }) {
    // Вкладки профиля (Media/Files/Links/Voice/Music) зовут без query, но с
    // type — фильтруем по типу контента вместо текстового поиска
    if (type && type !== 'text') {
      return Promise.resolve(buildSearchResults(filterMediaMessages(peer.id, type)));
    }
    return Promise.resolve(buildSearchResults(searchLocalMessages(query, peer.id)));
  },

  oldFetchLangPack({ langCode }: { langCode: string }) {
    return Promise.resolve({ langPack: buildOldLangPack(langCode) });
  },

  // ── стикеры (встроенный набор + кастомные паки) ─────────────────────────────
  async fetchStickerSets() {
    const { set, blobs } = await buildBuiltinStickerSet();
    // Регистрируем картинки/видео стикеров в media-кэше (хэш document<id>)
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, getStickerBlobMime(id));
    });
    const packs = await loadInstalledPacks(store.self);
    const customSets = packs.map((pack) => {
      const built = buildApiStickerSetFromPack(pack, INSTALLED_PACK_DATE);
      registerPackBlobs(built.blobs);
      return { ...built.set, stickers: undefined, count: built.set.count };
    });
    const hash = `1:${customSets.map(({ id }) => id).sort().join(',')}`;
    return { hash, sets: [{ ...set, stickers: undefined, count: set.count }, ...customSets] };
  },

  async fetchStickerSet(params?: { stickerSetInfo?: { id?: string; shortName?: string } }) {
    const info = params?.stickerSetInfo;
    const customSetId = info?.id && isCustomPackSetId(info.id)
      ? info.id
      : info?.shortName ? resolveSetIdByShortName(info.shortName) : undefined;
    if (customSetId) {
      const resolved = await resolveCustomPack(customSetId);
      if (!resolved) throw new Error('STICKERSET_INVALID');
      const built = buildApiStickerSetFromPack(resolved.pack, resolved.isInstalled
        ? INSTALLED_PACK_DATE : undefined);
      registerPackBlobs(built.blobs);
      return { set: built.set, stickers: built.set.stickers };
    }
    const wantsEmoji = info?.id === 'parvane-emoji' || info?.shortName === 'ParvaneEmoji';
    const { set, blobs } = wantsEmoji ? await buildBuiltinCustomEmojiSet() : await buildBuiltinStickerSet();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, getStickerBlobMime(id));
    });
    return { set, stickers: set.stickers };
  },

  async installStickerSet({ stickerSetId }: { stickerSetId: string }) {
    if (!isCustomPackSetId(stickerSetId)) return undefined;
    const resolved = await resolveCustomPack(stickerSetId);
    if (!resolved) return undefined;
    await saveInstalledPack(store.self, resolved.pack);
    const built = buildApiStickerSetFromPack(resolved.pack, INSTALLED_PACK_DATE);
    registerPackBlobs(built.blobs);
    sendUpdate({ '@type': 'updateStickerSet', id: built.set.id, stickerSet: built.set });
    return true;
  },

  async uninstallStickerSet({ stickerSetId }: { stickerSetId: string }) {
    const pack = await findInstalledPackBySetId(store.self, stickerSetId);
    if (!pack) return undefined;
    await removeInstalledPack(store.self, pack.name);
    sendUpdate({ '@type': 'updateStickerSet', id: stickerSetId, stickerSet: { installedDate: undefined } });
    return true;
  },

  // Создание пака из локальных файлов (Настройки → Стикеры). Имя уникализируем
  // суффиксом, чтобы не перетереть существующий набор
  async parvaneCreateStickerPack({ name, files }: { name: string; files: File[] }) {
    const packFiles: PackFile[] = [];
    for (const file of files) {
      if (!getPackFileMime(file.name)) continue;
      packFiles.push({ name: file.name, data: await file.arrayBuffer() });
    }
    if (!packFiles.length) return undefined;
    const baseName = sanitizePackName(name);
    const existing = await loadInstalledPacks(store.self);
    let finalName = baseName;
    let suffix = 2;
    while (existing.some((pack) => pack.name === finalName)) {
      finalName = sanitizePackName(`${baseName.slice(0, 28)} ${suffix}`);
      suffix += 1;
    }
    const pack: StoredPack = { name: finalName, files: packFiles };
    await saveInstalledPack(store.self, pack);
    const built = buildApiStickerSetFromPack(pack, INSTALLED_PACK_DATE);
    registerPackBlobs(built.blobs);
    sendUpdate({ '@type': 'updateStickerSet', id: built.set.id, stickerSet: built.set });
    return { title: finalName, count: packFiles.length };
  },

  // ── web-push (шард push, VAPID) ─────────────────────────────────────────────

  async parvaneGetPushKey() {
    if (!connection) return undefined;
    try {
      const raw = await connection.request(TOPIC_PUSH_VAPID_GET, JSON.stringify({}));
      const response = JSON.parse(raw) as { ok: boolean; public_key?: string };
      if (!response.ok || !response.public_key) return undefined;
      return { publicKey: response.public_key };
    } catch {
      return undefined;
    }
  },

  // token — JSON PushSubscription из notifications.tsx (getDeviceToken)
  async registerDevice(deviceToken: string) {
    if (!connection) return undefined;
    try {
      const subscription = JSON.parse(deviceToken) as { endpoint?: string; keys?: unknown };
      if (!subscription.endpoint || !subscription.keys) return undefined;
      const raw = await connection.request(TOPIC_PUSH_REGISTER, JSON.stringify({
        token,
        subscription,
      }));
      return (JSON.parse(raw) as { ok?: boolean }).ok ? true : undefined;
    } catch {
      return undefined;
    }
  },

  async unregisterDevice(deviceToken: string) {
    if (!connection) return undefined;
    try {
      const subscription = JSON.parse(deviceToken) as { endpoint?: string };
      const raw = await connection.request(TOPIC_PUSH_UNREGISTER, JSON.stringify({
        token,
        endpoint: subscription.endpoint,
      }));
      return (JSON.parse(raw) as { ok?: boolean }).ok ? true : undefined;
    } catch {
      return undefined;
    }
  },

  // ── C1: бэкап E2E-ключей (перенос на другое устройство) ─────────────────────

  async parvaneExportE2eKeys({ password }: { password: string }) {
    if (!e2e) return undefined;
    await e2e.flushStorage();
    return { payload: await e2e.exportEncrypted(password) };
  },

  async parvaneImportE2eKeys({ payload, password }: { payload: string; password: string }) {
    if (!store.self) return undefined;
    try {
      const imported = await E2eEngine.importEncrypted(store.self, payload, password);
      e2e = imported;
      // Полный ресинк с восстановленным состоянием: старая sealed-история
      // расшифруется из привезённого decCache
      syncController.reset();
      resetPackRegistries();
      sendUpdate({ '@type': 'requestSync' });
      return true;
    } catch (err) {
      logDebug(`импорт ключей не удался: ${String(err)}`);
      return undefined;
    }
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
      mediaService.cacheBlobIfAbsent(id, blob, 'image/png');
    });
    return { hash: '1', sets: [set] };
  },

  async fetchCustomEmoji({ documentId }: { documentId: string[] }) {
    const { set, blobs } = await buildBuiltinCustomEmojiSet();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, 'image/png');
    });
    return (set.stickers || []).filter((s) => documentId.includes(s.id));
  },

  async fetchSavedGifs() {
    const { gifs, blobs } = await buildBuiltinGifs();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, 'video/webm');
    });
    await messageController.ensureSavedGifsHydrated();
    const saved = messageController.getSavedGifs();
    return { hash: `1:${saved.length}`, gifs: [...saved, ...gifs] };
  },

  // ── запланированные сообщения (локальная очередь) ───────────────────────────

  fetchScheduledHistory({ chat }: { chat: ApiChat }) {
    return Promise.resolve({ messages: localState.fetchScheduledHistory(chat) });
  },

  deleteScheduledMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
    localState.deleteScheduledMessages(chat.id, messageIds);
    return Promise.resolve();
  },

  async sendScheduledMessages({ chat, ids }: { chat: ApiChat; ids: number[] }) {
    await localState.sendScheduledMessages(chat, ids);
  },

  rescheduleMessage({ chat, message, scheduledAt }: { chat: ApiChat; message: ApiMessage; scheduledAt: number }) {
    localState.rescheduleMessage(chat, message, scheduledAt);
    return Promise.resolve();
  },

  // ── звонки (программный API; UI-панель — window.parvaneCalls) ───────────────
  async parvanePlaceCall({ chat, isVideo }: { chat: ApiChat; isVideo?: boolean }) {
    return callController.placeCall(chat.id, isVideo);
  },

  async parvaneAcceptCall() {
    return callController.acceptIncoming();
  },

  parvaneHangUp() {
    callController.hangUp();
    return Promise.resolve(true);
  },

  parvaneToggleMute() {
    return Promise.resolve(callController.toggleMute());
  },

  parvaneToggleCamera() {
    return Promise.resolve(callController.toggleCamera());
  },

  // ── логин через штатные Auth-экраны ────────────────────────────────────────
  // «Телефон» = федеративный адрес user@server; дальше нативный экран пароля

  provideAuthPhoneNumber(address: string) {
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) {
      // Повторный WaitPhoneNumber сбрасывает auth.isLoading — иначе форма
      // навсегда останется в состоянии загрузки и не даст повторить ввод
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ErrorPhoneNumberInvalid' } });
      return Promise.resolve(undefined);
    }
    pendingLoginAddress = address;
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
    return Promise.resolve(undefined);
  },

  async provideAuthPassword(password: string) {
    const user = pendingLoginAddress || readLoginAddress();
    if (!user) {
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
      return;
    }
    try {
      await connectionController.connectAndLogin(user, password);
      saveLoginAddress(user);
    } catch (err) {
      logDebug(`логин отклонён: ${String(err)}`);
      // Повторный WaitPassword сбрасывает auth.isLoading, чтобы форма дала
      // ввести пароль ещё раз
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ErrorIncorrectPassword' } });
    }
  },

  restartAuth() {
    pendingLoginAddress = '';
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
    return Promise.resolve(undefined);
  },

  async fetchContactList() {
    await syncController.ensureSynced();
    const users = store.getKnownUserAddresses()
      .filter((address) => address !== store.self)
      .map((address) => store.buildApiUser(address));
    const userStatusesById: Record<string, ApiUserStatus> = {};
    users.forEach((user) => {
      userStatusesById[user.id] = RECENT_STATUS;
    });
    return { users, userStatusesById };
  },

  async updateProfile({ firstName, lastName }: { firstName?: string; lastName?: string; about?: string }) {
    const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (!connection || !displayName) return undefined;
    await connection.request(TOPIC_IDENTITY_SETNAME, JSON.stringify({ token, display_name: displayName }));
    store.setDisplayName(store.self, displayName);
    const user = store.buildApiUser(store.self);
    sendUpdate({ '@type': 'updateUser', id: user.id, user });
    sendUpdate({ '@type': 'updateCurrentUser', currentUser: user, currentUserFullInfo: {} });
    return true;
  },

  async uploadProfilePhoto(file: File) {
    if (!connection) return undefined;
    const { fileId } = await mediaService.uploadBlob(
      file,
      file.name || 'avatar.jpg',
      file.type || 'image/jpeg',
      { publicAccess: true },
    );
    await connection.request(TOPIC_IDENTITY_SETAVATAR, JSON.stringify({ token, file_id: fileId }));
    store.setAvatar(store.self, fileId);
    mediaService.cacheBlob(fileId, file, file.type || 'image/jpeg');
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

  // Профиль контакта: bio/username локальны у Parvane (нет серверного
  // профиля), но full-user нужен, чтобы экран профиля не оставался пустым
  fetchFullUser({ id }: { id: string }) {
    const address = store.getAddressForId(id);
    if (!address) return Promise.resolve(undefined);
    const user = store.buildApiUser(address);
    const isBlocked = localState.loadBlocked().includes(address);
    // `loadFullUser` без guard'ов читает `users`/`chats`/`userStatusesById` —
    // отдаём полную форму ответа, иначе TypeError в экшене
    return Promise.resolve({
      user,
      fullInfo: { isBlocked, commonChatsCount: 0 },
      users: [user],
      chats: [],
      userStatusesById: { [user.id]: RECENT_STATUS },
    });
  },

  updateIsOnline() {
    return Promise.resolve(undefined);
  },

  async destroy(noSessionClear?: boolean) {
    const user = store.self || pendingLoginAddress || readLoginAddress();
    const currentE2e = connectionController.shutdown();
    mediaService.clearCache();
    if (!noSessionClear) {
      clearLoginStorage();
      if (user) {
        try {
          await currentE2e?.flushStorage();
        } catch {
          // Logout всё равно обязан удалить повреждённое/недоступное хранилище.
        }
        localState.clearUserData(user);
        await E2eEngine.clear(user);
      }
    }
    return undefined;
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

function filterMediaMessages(chatId: string, type: string): ApiMessage[] {
  const matches = (message: ApiMessage): boolean => {
    const c = message.content;
    switch (type) {
      case 'media': return Boolean(c.photo || (c.video && !c.video.isRound && !c.video.isGif));
      case 'documents': return Boolean(c.document);
      case 'links': return Boolean(c.text?.text && /https?:\/\//.test(c.text.text));
      case 'voice': return Boolean(c.voice || (c.video && c.video.isRound));
      case 'audio': return Boolean(c.audio);
      case 'gif': return Boolean(c.video?.isGif);
      default: return false;
    }
  };
  return store.getMessages(chatId).filter(matches).sort((a, b) => b.date - a.date);
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
  if (update['@type'] === 'newMessage') {
    onUpdate({
      '@type': 'updateThreadInfo',
      threadInfo: {
        isCommentsInfo: false,
        chatId: update.chatId,
        threadId: MAIN_THREAD_ID,
        lastMessageId: update.id,
      },
    });
  }
  onUpdate(update);
}

// Пароль из login-link живёт только в памяти до первого connectAndLogin.
// Фрагмент удаляется из адресной строки до запуска UI.
function captureCredentialsFromHash() {
  const { hash } = window.location;
  if (!hash.startsWith(LOGIN_HASH_PREFIX)) return undefined;
  let credentials;
  try {
    credentials = parseLoginCredentials(decodeURIComponent(hash.slice(LOGIN_HASH_PREFIX.length)));
  } catch {
    credentials = undefined;
  }
  window.history.replaceState(undefined, '', window.location.pathname);
  return credentials;
}

function consumeStartupCredentials() {
  const hashCredentials = captureCredentialsFromHash();
  const legacyCredentials = consumeLegacyCredentials();
  return hashCredentials || legacyCredentials;
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
