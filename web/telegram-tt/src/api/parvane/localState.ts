import type { SendMessageParams } from '../../types';
import type { ApiChat, ApiMessage, ApiUpdate } from '../types';
import type { E2eEngine } from './e2e';
import type { ParvaneStore } from './store';
import type { WireStoredMessage } from './wire';

type ScheduledEntry = {
  id: number;
  chatId: string;
  scheduledAt: number;
  text?: string;
  entities?: SendMessageParams['entities'];
  replyToMsgId?: number;
  // Медиа/опрос/стикер нельзя восстановить из localStorage, поэтому полные
  // параметры живут только до конца текущей вкладки.
  params?: SendMessageParams;
};

type LocalStateDependencies = {
  getStore: () => ParvaneStore;
  getE2e: () => E2eEngine | undefined;
  isAuthorized: () => boolean;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  buildLocalContent: (uuid: string, params: SendMessageParams) => ApiMessage['content'];
  sendMessage: (params: SendMessageParams) => Promise<unknown>;
};

const SCHEDULED_CHECK_INTERVAL_MS = 5000;
const SCHEDULED_ID_BASE = 1_000_001;

export function createLocalState(deps: LocalStateDependencies) {
  const scheduledQueue: ScheduledEntry[] = [];
  let isScheduledLoaded = false;
  let scheduledNextId = SCHEDULED_ID_BASE;

  const storageKey = (part: string) => `parvane:${part}:${deps.getStore().self}`;

  function loadScheduledQueue() {
    const { self } = deps.getStore();
    if (isScheduledLoaded || !self) return;
    isScheduledLoaded = true;
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey('scheduled')) || '[]') as ScheduledEntry[];
      scheduledQueue.push(...raw);
      scheduledNextId = Math.max(scheduledNextId, ...raw.map((entry) => entry.id + 1));
    } catch {
      // Повреждённая локальная очередь эквивалентна пустой.
    }
  }

  function persistScheduledQueue() {
    const persistable = scheduledQueue.filter((entry) => !entry.params);
    localStorage.setItem(storageKey('scheduled'), JSON.stringify(persistable));
  }

  function buildScheduledApiMessage(entry: ScheduledEntry): ApiMessage {
    const content = entry.params
      ? deps.buildLocalContent(crypto.randomUUID(), entry.params)
      : { text: { text: entry.text || '', entities: entry.entities } };
    return {
      id: entry.id,
      chatId: entry.chatId,
      content,
      date: entry.scheduledAt,
      isOutgoing: true,
      senderId: deps.selfId(),
      isScheduled: true,
      replyInfo: entry.replyToMsgId ? { type: 'message', replyToMsgId: entry.replyToMsgId } : undefined,
    };
  }

  function rebuildChatForScheduled(chatId: string): ApiChat | undefined {
    const store = deps.getStore();
    const address = store.getAddressForId(chatId);
    if (!address) return undefined;
    const groupInfo = store.getGroupInfo(address);
    return groupInfo ? store.buildApiChatForGroup(groupInfo) : store.buildApiChatForUser(address);
  }

  function removeScheduled(chatId: string, ids: number[]) {
    ids.forEach((id) => {
      const index = scheduledQueue.findIndex((entry) => entry.id === id && entry.chatId === chatId);
      if (index >= 0) scheduledQueue.splice(index, 1);
    });
    persistScheduledQueue();
    deps.sendUpdate({ '@type': 'deleteScheduledMessages', ids, chatId });
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
    await deps.sendMessage(params);
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
    deps.sendUpdate({
      '@type': 'newScheduledMessage',
      chatId: chat.id,
      id: entry.id,
      message: buildScheduledApiMessage(entry),
    });
  }

  async function checkDueScheduled() {
    if (!deps.getStore().self || !deps.isAuthorized()) return;
    loadScheduledQueue();
    const now = Math.floor(Date.now() / 1000);
    const due = scheduledQueue.filter((entry) => entry.scheduledAt <= now);
    for (const entry of due) {
      await fireScheduled(entry);
    }
  }

  window.setInterval(() => {
    void checkDueScheduled();
  }, SCHEDULED_CHECK_INTERVAL_MS);

  function readOwnJournal(): WireStoredMessage[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('hist')) || '[]');
    } catch {
      return [];
    }
  }

  function appendOwnJournal(entry: WireStoredMessage) {
    const list = readOwnJournal();
    list.push(entry);
    localStorage.setItem(storageKey('hist'), JSON.stringify(list));
  }

  function loadPeerTtl(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem(storageKey('ttl')) || '{}');
    } catch {
      return {};
    }
  }

  function savePeerTtl(map: Record<string, number>) {
    localStorage.setItem(storageKey('ttl'), JSON.stringify(map));
  }

  function scheduleTtlDeletion(chatId: string, messageId: number, ttlSecs: number) {
    window.setTimeout(() => {
      const store = deps.getStore();
      // Снять расшифрованный inner из persisted-кэша ДО удаления сообщения
      // (после removeMessage маппинг id→uuid теряется). Иначе plaintext
      // «самоуничтожающегося» сообщения остаётся на диске навсегда
      const uuid = store.getUuidForMessage(chatId, messageId);
      if (uuid) deps.getE2e()?.dropCachedInner(uuid);
      store.removeMessage(chatId, messageId);
      deps.sendUpdate({ '@type': 'deleteMessages', ids: [messageId], chatId });
    }, ttlSecs * 1000);
  }

  function loadBlocked(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('blocked')) || '[]');
    } catch {
      return [];
    }
  }

  function saveBlocked(list: string[]) {
    localStorage.setItem(storageKey('blocked'), JSON.stringify(list));
  }

  function isBlocked(address: string) {
    return loadBlocked().includes(address);
  }

  function loadFolders(): { id: number; [key: string]: unknown }[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('folders')) || '[]');
    } catch {
      return [];
    }
  }

  function saveFolders(folders: { id: number; [key: string]: unknown }[]) {
    localStorage.setItem(storageKey('folders'), JSON.stringify(folders));
  }

  // Черновики: chatId → draft (сериализованный ApiDraft). localStorage общий
  // для вкладок — конфликт решается last-write-wins по date
  function loadDrafts(): Record<string, Record<string, unknown>> {
    try {
      return JSON.parse(localStorage.getItem(storageKey('drafts')) || '{}');
    } catch {
      return {};
    }
  }

  function saveDraft(chatId: string, draft?: Record<string, unknown>) {
    const drafts = loadDrafts();
    const current = drafts[chatId];
    const currentDate = typeof current?.date === 'number' ? current.date : 0;
    const nextDate = typeof draft?.date === 'number' ? draft.date : Math.floor(Date.now() / 1000);
    if (draft && currentDate > nextDate) return;
    if (draft) drafts[chatId] = { ...draft, date: nextDate };
    else delete drafts[chatId];
    localStorage.setItem(storageKey('drafts'), JSON.stringify(drafts));
  }

  // Закреплённые чаты (адреса пиров, порядок = порядок пина) и архив
  function loadPinned(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('pinned')) || '[]');
    } catch {
      return [];
    }
  }

  function setPinned(address: string, shouldPin: boolean) {
    const pinned = loadPinned().filter((a) => a !== address);
    if (shouldPin) pinned.unshift(address);
    localStorage.setItem(storageKey('pinned'), JSON.stringify(pinned));
  }

  function loadArchived(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('archived')) || '[]');
    } catch {
      return [];
    }
  }

  function setArchived(address: string, shouldArchive: boolean) {
    const archived = loadArchived().filter((a) => a !== address);
    if (shouldArchive) archived.push(address);
    localStorage.setItem(storageKey('archived'), JSON.stringify(archived));
  }

  // Notify-настройки чатов (mute/превью) по адресу пира/группы
  function loadNotifyExceptions(): Record<string, Record<string, unknown>> {
    try {
      return JSON.parse(localStorage.getItem(storageKey('notify')) || '{}');
    } catch {
      return {};
    }
  }

  function saveNotifyExceptions(map: Record<string, Record<string, unknown>>) {
    localStorage.setItem(storageKey('notify'), JSON.stringify(map));
  }

  // Дефолты уведомлений по типам чатов (users/groups/channels)
  function loadNotifyDefaults(): Record<string, Record<string, unknown>> {
    try {
      return JSON.parse(localStorage.getItem(storageKey('notifydefaults')) || '{}');
    } catch {
      return {};
    }
  }

  function saveNotifyDefaults(map: Record<string, Record<string, unknown>>) {
    localStorage.setItem(storageKey('notifydefaults'), JSON.stringify(map));
  }

  function clearUserData(user: string) {
    [
      'scheduled', 'hist', 'ttl', 'blocked', 'folders', 'drafts', 'pinned', 'archived', 'notify', 'notifydefaults',
    ].forEach((part) => {
      localStorage.removeItem(`parvane:${part}:${user}`);
    });
  }

  function fetchScheduledHistory(chat: ApiChat) {
    loadScheduledQueue();
    return scheduledQueue
      .filter((entry) => entry.chatId === chat.id)
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
      .map(buildScheduledApiMessage);
  }

  async function sendScheduledMessages(chat: ApiChat, ids: number[]) {
    loadScheduledQueue();
    for (const id of ids) {
      const entry = scheduledQueue.find((candidate) => candidate.chatId === chat.id && candidate.id === id);
      if (entry) await fireScheduled(entry);
    }
  }

  function rescheduleMessage(chat: ApiChat, message: ApiMessage, scheduledAt: number) {
    loadScheduledQueue();
    const entry = scheduledQueue.find((candidate) => (
      candidate.chatId === chat.id && candidate.id === message.id
    ));
    if (!entry) return;
    entry.scheduledAt = scheduledAt;
    persistScheduledQueue();
    deps.sendUpdate({
      '@type': 'updateScheduledMessage',
      chatId: chat.id,
      id: entry.id,
      message: buildScheduledApiMessage(entry),
    });
  }

  return {
    appendOwnJournal,
    clearUserData,
    deleteScheduledMessages: removeScheduled,
    fetchScheduledHistory,
    loadArchived,
    loadBlocked,
    loadDrafts,
    loadFolders,
    isBlocked,
    loadNotifyDefaults,
    loadNotifyExceptions,
    loadPeerTtl,
    loadPinned,
    saveNotifyDefaults,
    saveNotifyExceptions,
    readOwnJournal,
    rescheduleMessage,
    saveBlocked,
    saveDraft,
    saveFolders,
    setArchived,
    setPinned,
    savePeerTtl,
    scheduleMessage,
    scheduleTtlDeletion,
    sendScheduledMessages,
  };
}
