import type { SendMessageParams } from '../../types';
import type { ApiChat, ApiMessage, ApiUpdate } from '../types';
import type { E2eEngine } from './e2e';
import type { ParvaneStore } from './store';
import type { WireStoredMessage } from './wire';

import { SecureE2eStorage } from './secureStorage';

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
const RECORD_SAVE_DELAY_MS = 300;
const HISTORY_FLUSH_DELAY_MS = 500;
// v2: курсоры, сохранённые до hotfix AAD (E2E был недоступен, сообщения
// пропускались), не должны использоваться
const SYNC_CURSOR_RECORD = 'cursor.v2';
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const JOURNAL_MAX_ENTRIES = 5000;

export function createLocalState(deps: LocalStateDependencies) {
  const scheduledQueue: ScheduledEntry[] = [];
  let isScheduledLoaded = false;
  let scheduledNextId = SCHEDULED_ID_BASE;

  const storageKey = (part: string) => `parvane:${part}:${deps.getStore().self}`;

  // ── шифрованные записи (журнал исходящих, черновики) ──────────────────────
  // Исходящий журнал несёт ОТКРЫТЫЙ текст сообщений и file_key/file_nonce
  // вложений, черновики — текст; в localStorage это отдавало всю исходящую
  // переписку любому дампу. Теперь — IndexedDB под non-extractable ключом
  // SecureE2eStorage (тот же, что у E2E-состояния), с одноразовой миграцией.
  let secureUser = '';
  let securePromise: Promise<SecureE2eStorage> | undefined;
  let journalCache: WireStoredMessage[] | undefined;
  let draftsCache: Record<string, Record<string, unknown>> | undefined;
  let journalSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let draftsSaveTimer: ReturnType<typeof setTimeout> | undefined;

  function secureStorage() {
    const { self } = deps.getStore();
    if (!self) return undefined;
    if (!securePromise || secureUser !== self) {
      secureUser = self;
      securePromise = SecureE2eStorage.open(self);
    }
    return securePromise;
  }

  function readLegacyJson<T>(key: string, fallback: T): T {
    try {
      return JSON.parse(localStorage.getItem(key) || '') as T;
    } catch {
      return fallback;
    }
  }

  // Загрузить журнал и черновики (один раз на сессию) — с миграцией из
  // localStorage. Зовётся перед первым чтением (sync/fetchChats).
  async function hydrate() {
    if (journalCache && draftsCache) return;
    const storage = await secureStorage();
    if (!storage) {
      journalCache = journalCache || [];
      draftsCache = draftsCache || {};
      return;
    }
    if (!journalCache) {
      const stored = await storage.loadRecord<WireStoredMessage[]>('journal');
      const legacy = readLegacyJson<WireStoredMessage[]>(storageKey('hist'), []);
      journalCache = stored || [];
      if (legacy.length) {
        const known = new Set(journalCache.map((m) => m.id));
        legacy.forEach((m) => {
          if (!known.has(m.id)) {
            journalCache!.push(m);
          }
        });
        await storage.saveRecord('journal', journalCache);
        localStorage.removeItem(storageKey('hist'));
      }
    }
    if (!draftsCache) {
      const stored = await storage.loadRecord<Record<string, Record<string, unknown>>>('drafts');
      const legacy = readLegacyJson<Record<string, Record<string, unknown>>>(storageKey('drafts'), {});
      draftsCache = stored || {};
      if (Object.keys(legacy).length) {
        draftsCache = { ...legacy, ...draftsCache };
        await storage.saveRecord('drafts', draftsCache);
        localStorage.removeItem(storageKey('drafts'));
      }
    }
  }

  function scheduleRecordSave(name: 'journal' | 'drafts') {
    const isJournal = name === 'journal';
    if (isJournal ? journalSaveTimer : draftsSaveTimer) return;
    const timer = setTimeout(() => {
      if (isJournal) {
        journalSaveTimer = undefined;
      } else {
        draftsSaveTimer = undefined;
      }
      void secureStorage()?.then((storage) => storage.saveRecord(
        name, isJournal ? (journalCache || []) : (draftsCache || {}),
      )).catch(() => undefined);
    }, RECORD_SAVE_DELAY_MS);
    if (isJournal) {
      journalSaveTimer = timer;
    } else {
      draftsSaveTimer = timer;
    }
  }

  // ── кэш истории и курсор синка (шифрованные записи m:<uuid>, cursor) ────
  const historyWriteQueue = new Map<string, WireStoredMessage | undefined>();
  let historyFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let cursorPending: { lastSeenUuid: string; sinceUpdated: number } | undefined;

  function flushHistoryQueue(): Promise<void> {
    if (historyFlushTimer) clearTimeout(historyFlushTimer);
    historyFlushTimer = undefined;
    const batch = Array.from(historyWriteQueue.entries());
    historyWriteQueue.clear();
    const cursor = cursorPending;
    cursorPending = undefined;
    if (!batch.length && !cursor) return Promise.resolve();
    const pending = secureStorage();
    if (!pending) return Promise.resolve();
    return pending.then(async (storage) => {
      for (const [uuid, stored] of batch) {
        if (stored) await storage.saveRecord(`m:${uuid}`, stored);
        else await storage.deleteRecord(`m:${uuid}`);
      }
      if (cursor) await storage.saveRecord(SYNC_CURSOR_RECORD, cursor);
    }).catch(() => undefined);
  }

  // Уход со страницы: дописать очередь кэша сразу (иначе удаление/очистка,
  // сделанные за <500 мс до reload, терялись — курсор уже записан, а сервер
  // скрытое повторно не отдаст → в кэше навсегда оставались старые строки)
  // Журнал исходящих и черновики тоже: сообщение «Избранному» без других
  // устройств живёт ТОЛЬКО в журнале — reload сразу после отправки терял его
  function flushRecordSaves() {
    if (journalSaveTimer) {
      clearTimeout(journalSaveTimer);
      journalSaveTimer = undefined;
      void secureStorage()?.then((storage) => storage.saveRecord('journal', journalCache || [])).catch(() => undefined);
    }
    if (draftsSaveTimer) {
      clearTimeout(draftsSaveTimer);
      draftsSaveTimer = undefined;
      void secureStorage()?.then((storage) => storage.saveRecord('drafts', draftsCache || {})).catch(() => undefined);
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void flushHistoryQueue();
      flushRecordSaves();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void flushHistoryQueue();
        flushRecordSaves();
      }
    });
  }

  // Удалённые «для меня» личные чаты (по адресу пира): не показывать в списке,
  // пока в чате нет ни одного сообщения (новое входящее возвращает чат). Без
  // этого пир, известный по составу общей группы, всплывал бы пустым чатом
  function loadDeletedChats(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('deletedchats')) || '[]');
    } catch {
      return [];
    }
  }

  function markChatDeleted(address: string) {
    const list = loadDeletedChats();
    if (!list.includes(address)) localStorage.setItem(storageKey('deletedchats'), JSON.stringify([...list, address]));
  }

  function unmarkChatDeleted(address: string) {
    const list = loadDeletedChats();
    if (list.includes(address)) {
      localStorage.setItem(storageKey('deletedchats'), JSON.stringify(list.filter((item) => item !== address)));
    }
  }

  function scheduleHistoryFlush() {
    if (historyFlushTimer) return;
    historyFlushTimer = setTimeout(flushHistoryQueue, HISTORY_FLUSH_DELAY_MS);
  }

  function saveHistoryRecord(stored: WireStoredMessage) {
    historyWriteQueue.set(stored.id, stored);
    scheduleHistoryFlush();
  }

  function deleteHistoryRecord(uuid: string) {
    historyWriteQueue.set(uuid, undefined);
    scheduleHistoryFlush();
  }

  async function loadHistoryRecords(): Promise<WireStoredMessage[]> {
    const storage = await secureStorage();
    if (!storage) return [];
    return storage.loadRecordsByPrefix<WireStoredMessage>('m:');
  }

  function saveSyncCursor(cursor: { lastSeenUuid: string; sinceUpdated: number }) {
    cursorPending = cursor;
    scheduleHistoryFlush();
  }

  async function loadSyncCursor() {
    const storage = await secureStorage();
    if (!storage) return undefined;
    return storage.loadRecord<{ lastSeenUuid: string; sinceUpdated: number }>(SYNC_CURSOR_RECORD);
  }

  function resetSecureCaches() {
    historyWriteQueue.clear();
    cursorPending = undefined;
    if (historyFlushTimer) clearTimeout(historyFlushTimer);
    historyFlushTimer = undefined;
    journalCache = undefined;
    draftsCache = undefined;
    securePromise = undefined;
    secureUser = '';
    if (journalSaveTimer) clearTimeout(journalSaveTimer);
    if (draftsSaveTimer) clearTimeout(draftsSaveTimer);
    journalSaveTimer = undefined;
    draftsSaveTimer = undefined;
  }

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

  async function readOwnJournal(): Promise<WireStoredMessage[]> {
    await hydrate();
    return (journalCache || []).slice();
  }

  function appendOwnJournal(entry: WireStoredMessage) {
    // До hydrate (сразу после логина) копим в памяти — hydrate сольёт с записью
    journalCache = journalCache || [];
    journalCache.push(entry);
    if (journalCache.length > JOURNAL_MAX_ENTRIES) {
      journalCache.splice(0, journalCache.length - JOURNAL_MAX_ENTRIES);
    }
    scheduleRecordSave('journal');
  }

  // Очистка истории: убрать свои исходящие из журнала СРАЗУ (журнал сливается
  // с выдачей sync на полном синке — без этого удалённый чат воскресал из
  // собственных сообщений после reload)
  async function removeOwnJournalEntries(uuids: string[]) {
    await hydrate();
    const drop = new Set(uuids);
    const before = journalCache?.length || 0;
    journalCache = (journalCache || []).filter((entry) => !drop.has(entry.id));
    if (journalCache.length === before) return;
    if (journalSaveTimer) clearTimeout(journalSaveTimer);
    journalSaveTimer = undefined;
    await secureStorage()?.then((storage) => storage.saveRecord('journal', journalCache || []))
      .catch(() => undefined);
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

  // Таймеры TTL: setTimeout переполняется на ~24.8 сутках (срабатывал сразу
  // для «1 месяц»), поэтому длинные сроки ждём отрезками; на logout гасим
  const ttlTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleTtlDeletion(chatId: string, messageId: number, ttlSecs: number) {
    armTtl(chatId, messageId, Date.now() + Math.max(0, ttlSecs) * 1000);
  }

  function armTtl(chatId: string, messageId: number, deadlineMs: number) {
    const key = `${chatId}:${messageId}`;
    const existing = ttlTimers.get(key);
    if (existing) clearTimeout(existing);
    const delay = Math.min(Math.max(0, deadlineMs - Date.now()), MAX_TIMEOUT_MS);
    ttlTimers.set(key, setTimeout(() => {
      ttlTimers.delete(key);
      if (Date.now() < deadlineMs) {
        armTtl(chatId, messageId, deadlineMs);
        return;
      }
      const store = deps.getStore();
      // Снять расшифрованный inner из persisted-кэша ДО удаления сообщения
      // (после removeMessage маппинг id→uuid теряется). Иначе plaintext
      // «самоуничтожающегося» сообщения остаётся на диске навсегда
      const uuid = store.getUuidForMessage(chatId, messageId);
      if (uuid) deps.getE2e()?.dropCachedInner(uuid);
      store.removeMessage(chatId, messageId);
      deps.sendUpdate({ '@type': 'deleteMessages', ids: [messageId], chatId });
    }, delay));
  }

  function clearTtlTimers() {
    ttlTimers.forEach((timer) => clearTimeout(timer));
    ttlTimers.clear();
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

  // Явно добавленные контакты (адреса) — телефонной книги у Parvane нет
  function loadContacts(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('contacts')) || '[]');
    } catch {
      return [];
    }
  }

  function saveContacts(list: string[]) {
    localStorage.setItem(storageKey('contacts'), JSON.stringify(list));
  }

  function loadNonContacts(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('noncontacts')) || '[]');
    } catch {
      return [];
    }
  }

  function saveNonContacts(list: string[]) {
    localStorage.setItem(storageKey('noncontacts'), JSON.stringify(list));
  }

  // «Отметить непрочитанным»: chatId с ручной пометкой (сервер такого не хранит)
  function loadUnreadMarks(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('unreadmarks')) || '[]');
    } catch {
      return [];
    }
  }

  function saveUnreadMarks(chatIds: string[]) {
    localStorage.setItem(storageKey('unreadmarks'), JSON.stringify(chatIds));
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
    // Синхронно из кэша: hydrate() вызывается провайдером перед fetchChats
    return draftsCache || {};
  }

  function saveDraft(chatId: string, draft?: Record<string, unknown>) {
    const drafts = loadDrafts();
    const current = drafts[chatId];
    const currentDate = typeof current?.date === 'number' ? current.date : 0;
    const nextDate = typeof draft?.date === 'number' ? draft.date : Math.floor(Date.now() / 1000);
    if (draft && currentDate > nextDate) return;
    if (draft) drafts[chatId] = { ...draft, date: nextDate };
    else delete drafts[chatId];
    draftsCache = drafts;
    scheduleRecordSave('drafts');
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
      'scheduled', 'hist', 'ttl', 'blocked', 'contacts', 'noncontacts', 'folders', 'drafts', 'pinned', 'archived',
      'notify', 'notifydefaults',
    ].forEach((part) => {
      localStorage.removeItem(`parvane:${part}:${user}`);
    });
    resetSecureCaches();
    void SecureE2eStorage.clearRecords(user).catch(() => undefined);
  }

  // Смена аккаунта: очереди/кэши прежнего пользователя не должны утечь в
  // ключи нового (persist считается от текущего self)
  function reset() {
    scheduledQueue.length = 0;
    isScheduledLoaded = false;
    scheduledNextId = SCHEDULED_ID_BASE;
    resetSecureCaches();
    clearTtlTimers();
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
    hydrate,
    reset,
    saveHistoryRecord,
    deleteHistoryRecord,
    loadHistoryRecords,
    saveSyncCursor,
    loadSyncCursor,
    appendOwnJournal,
    clearUserData,
    deleteScheduledMessages: removeScheduled,
    fetchScheduledHistory,
    loadArchived,
    loadBlocked,
    loadContacts,
    loadNonContacts,
    loadDeletedChats,
    loadUnreadMarks,
    markChatDeleted,
    unmarkChatDeleted,
    removeOwnJournalEntries,
    flushHistoryNow: flushHistoryQueue,
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
    saveContacts,
    saveNonContacts,
    saveUnreadMarks,
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
