import type { SendMessageParams } from '../../types';
import type { ApiChat, ApiMessage, ApiUpdate } from '../types';
import type { ParvaneStore } from './store';
import type { WireStoredMessage } from './wire';

import { SecureE2eStorage } from './secureStorage';
import { newMessageId } from './wire';

type ScheduledEntry = {
  id: number;
  chatId: string;
  scheduledAt: number;
  // op_id отложенного в журнале личного состояния (T098) = uuid сообщения при
  // отправке: дубль с другого устройства отсекается по нему
  opId?: string;
  text?: string;
  entities?: SendMessageParams['entities'];
  replyToMsgId?: number;
  // Медиа/опрос/стикер нельзя восстановить из localStorage, поэтому полные
  // параметры живут только до конца текущей вкладки.
  params?: SendMessageParams;
};

// Вид локальных данных, изменённых пользователем (журнал личного состояния, T098)
export type LocalStateKind = 'folders' | 'blocked' | 'drafts' | 'scheduled' | 'archived' | 'pinned' | 'notify';

// Текстовое отложенное сообщение в виде для журнала личного состояния
export type JournalScheduled = {
  opId: string;
  chatId: string;
  scheduledAt: number;
  text?: string;
  entities?: SendMessageParams['entities'];
};

type LocalStateDependencies = {
  getStore: () => ParvaneStore;
  isAuthorized: () => boolean;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  buildLocalContent: (uuid: string, params: SendMessageParams) => ApiMessage['content'];
  sendMessage: (params: SendMessageParams, uuid?: string) => Promise<unknown>;
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

  // Журнал личного состояния (T098) слушает правки пользователя; запись
  // пришедшего из журнала (applyingJournal) слушателя не будит
  let changeListener: ((kind: LocalStateKind) => void) | undefined;
  let applyingJournal = false;
  // Перед отправкой отложенного журнал проверяет, не отправило ли его другое устройство
  let scheduledGate: ((opId: string) => Promise<boolean>) | undefined;
  let scheduledSent: ((opId: string) => void) | undefined;

  // Виды, правку которых журнал ещё не принял: переживают перезагрузку, чтобы
  // подключение журнала сначала дослало их, а не затёрло снимком с сервера
  // (блокировка, сделанная за секунду до reload или до подъёма v2, терялась)
  let dirtyRevision = 0;

  function loadDirtyKinds(): LocalStateKind[] {
    try {
      const kinds = JSON.parse(localStorage.getItem(storageKey('statedirty')) || '[]') as LocalStateKind[];
      return Array.isArray(kinds) ? kinds : [];
    } catch {
      return [];
    }
  }

  function markDirty(kind: LocalStateKind) {
    dirtyRevision += 1;
    const kinds = loadDirtyKinds();
    if (kinds.includes(kind)) return;
    try {
      localStorage.setItem(storageKey('statedirty'), JSON.stringify([...kinds, kind]));
    } catch {
      // Квота/приватный режим: правка уйдёт обычным путём, пока вкладка жива
    }
  }

  /** Журнал принял всё, что было несохранённым на момент `revision`. */
  function clearDirtyKinds(revision: number) {
    if (revision !== dirtyRevision) return;
    try {
      localStorage.removeItem(storageKey('statedirty'));
    } catch {
      // См. markDirty
    }
  }

  function notifyChange(kind: LocalStateKind) {
    if (applyingJournal) return;
    markDirty(kind);
    changeListener?.(kind);
  }

  function applyFromJournal(fn: () => void) {
    applyingJournal = true;
    try {
      fn();
    } finally {
      applyingJournal = false;
    }
  }

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
    // P-44: очередь запланированных (текст сообщений) — тоже в шифрованном
    // хранилище, с миграцией из localStorage
    if (!isScheduledLoaded) {
      isScheduledLoaded = true;
      const stored = (await storage.loadRecord<ScheduledEntry[]>('scheduled')) || [];
      const legacy = readLegacyJson<ScheduledEntry[]>(storageKey('scheduled'), []);
      scheduledQueue.push(...stored, ...legacy);
      scheduledNextId = Math.max(scheduledNextId, ...scheduledQueue.map((entry) => entry.id + 1));
      if (legacy.length) {
        await storage.saveRecord('scheduled', scheduledQueue.filter((entry) => !entry.params));
        localStorage.removeItem(storageKey('scheduled'));
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

  // Записи идут строго одна пачка за другой: сброс очереди может быть вызван,
  // пока предыдущая пачка ещё пишется (своё исходящее сбрасывается сразу), —
  // иначе удаление обогнало бы незавершённое сохранение той же записи
  let historyFlushChain: Promise<void> = Promise.resolve();

  function flushHistoryQueue(): Promise<void> {
    if (historyFlushTimer) clearTimeout(historyFlushTimer);
    historyFlushTimer = undefined;
    const batch = Array.from(historyWriteQueue.entries());
    historyWriteQueue.clear();
    const cursor = cursorPending;
    cursorPending = undefined;
    if (!batch.length && !cursor) return historyFlushChain;
    const pending = secureStorage();
    if (!pending) return historyFlushChain;
    historyFlushChain = historyFlushChain.then(() => pending).then(async (storage) => {
      for (const [uuid, stored] of batch) {
        try {
          if (stored) await storage.saveRecord(`m:${uuid}`, stored);
          else await storage.deleteRecord(`m:${uuid}`);
        } catch (err) {
          // Сбой одной записи не должен ронять остаток пачки и не должен быть немым:
          // сообщение без записи в кэше пропадает после перезагрузки
          // eslint-disable-next-line no-console
          console.warn(`[parvane] кэш истории: запись ${uuid} не сохранена: ${String(err)}`);
        }
      }
      if (cursor) await storage.saveRecord(SYNC_CURSOR_RECORD, cursor);
    }).catch(() => undefined);
    return historyFlushChain;
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

  // Граница очистки чата «у себя» (T145): адрес → время (мс), не позже
  // которого сообщения скрыты. В v2 она едет журналом личного состояния на
  // остальные свои устройства (в v1 — нотис `cleared` с id сообщений)
  function loadClearedUntil(): Record<string, number> {
    try {
      const map = JSON.parse(localStorage.getItem(storageKey('cleareduntil')) || '{}') as Record<string, number>;
      return map && typeof map === 'object' ? map : {};
    } catch {
      return {};
    }
  }

  /** true — граница выросла (раньше была меньше либо не было). */
  function saveClearedUntil(address: string, untilMs: number) {
    const map = loadClearedUntil();
    if ((map[address] || 0) >= untilMs) return false;
    map[address] = untilMs;
    try {
      localStorage.setItem(storageKey('cleareduntil'), JSON.stringify(map));
    } catch {
      // Квота/приватный режим: граница живёт до перезагрузки
    }
    return true;
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

  // Очередь загружается в hydrate() (шифрованное хранилище); до него —
  // legacy-чтение из localStorage, чтобы ранние вызовы не теряли записи
  function loadScheduledQueue() {
    const { self } = deps.getStore();
    if (isScheduledLoaded || !self) return;
    isScheduledLoaded = true;
    const raw = readLegacyJson<ScheduledEntry[]>(storageKey('scheduled'), []);
    scheduledQueue.push(...raw);
    scheduledNextId = Math.max(scheduledNextId, ...raw.map((entry) => entry.id + 1));
  }

  function persistScheduledQueue() {
    const persistable = scheduledQueue.filter((entry) => !entry.params);
    void secureStorage()?.then((storage) => {
      if (!storage) return undefined;
      return storage.saveRecord('scheduled', persistable).then(() => {
        try {
          localStorage.removeItem(storageKey('scheduled'));
        } catch {
          // приватный режим
        }
      });
    }).catch(() => undefined);
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
    notifyChange('scheduled');
  }

  async function fireScheduled(entry: ScheduledEntry) {
    // Отложенное из журнала: первое устройство, заметившее срок, отправляет его
    // с op_id отложенного; другое устройство уже отправило — только убрать
    if (entry.opId && scheduledGate && !(await scheduledGate(entry.opId))) {
      applyFromJournal(() => removeScheduled(entry.chatId, [entry.id]));
      return;
    }
    const chat = entry.params?.chat || rebuildChatForScheduled(entry.chatId);
    applyFromJournal(() => removeScheduled(entry.chatId, [entry.id]));
    if (!chat) return;
    const params: SendMessageParams = entry.params
      ? { ...entry.params, scheduledAt: undefined }
      : {
        chat,
        text: entry.text,
        entities: entry.entities,
        replyInfo: entry.replyToMsgId ? { type: 'message', replyToMsgId: entry.replyToMsgId } : undefined,
      };
    await deps.sendMessage(params, entry.opId);
    if (entry.opId) scheduledSent?.(entry.opId);
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
      opId: hasMedia ? undefined : newMessageId(),
    };
    scheduledQueue.push(entry);
    persistScheduledQueue();
    deps.sendUpdate({
      '@type': 'newScheduledMessage',
      chatId: chat.id,
      id: entry.id,
      message: buildScheduledApiMessage(entry),
    });
    notifyChange('scheduled');
  }

  // Текстовые отложенные для журнала (медиа живут только во вкладке)
  function listJournalScheduled(): JournalScheduled[] {
    loadScheduledQueue();
    return scheduledQueue.filter((entry) => entry.opId && !entry.params).map((entry) => ({
      opId: entry.opId!,
      chatId: entry.chatId,
      scheduledAt: entry.scheduledAt,
      text: entry.text,
      entities: entry.entities,
    }));
  }

  // Сведённые журналом отложенные: новые — в очередь, пропавшие — убрать,
  // перенесённые — новый срок
  function applyJournalScheduled(list: JournalScheduled[]) {
    loadScheduledQueue();
    applyFromJournal(() => {
      const byOpId = new Map(list.map((item) => [item.opId, item]));
      scheduledQueue
        .filter((entry) => entry.opId && !entry.params && !byOpId.has(entry.opId))
        .forEach((entry) => removeScheduled(entry.chatId, [entry.id]));
      list.forEach((item) => {
        const existing = scheduledQueue.find((entry) => entry.opId === item.opId);
        if (existing) {
          if (existing.scheduledAt === item.scheduledAt && existing.text === item.text) return;
          existing.scheduledAt = item.scheduledAt;
          existing.text = item.text;
          existing.entities = item.entities;
          deps.sendUpdate({
            '@type': 'updateScheduledMessage',
            chatId: existing.chatId,
            id: existing.id,
            message: buildScheduledApiMessage(existing),
          });
          return;
        }
        const entry: ScheduledEntry = {
          id: scheduledNextId++,
          chatId: item.chatId,
          scheduledAt: item.scheduledAt,
          text: item.text,
          entities: item.entities,
          opId: item.opId,
        };
        scheduledQueue.push(entry);
        deps.sendUpdate({
          '@type': 'newScheduledMessage', chatId: entry.chatId, id: entry.id, message: buildScheduledApiMessage(entry),
        });
      });
      persistScheduledQueue();
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
    // Своё исходящее пишем на диск сразу, без отложенной записи: вкладка,
    // закрытая в первую секунду после отправки, теряла сообщение — запись,
    // начатая в pagehide, не успевает (шифрование и IndexedDB асинхронны), а
    // сервер своё сообщение не вернёт (v2; v1 после отключения — тем более)
    scheduleRecordSave('journal');
    flushRecordSaves();
    // Своё исходящее — сразу и в кэш истории. Сервер не шлёт эхо отправителю:
    // копия для своего устройства приходит только дельта-синком, а живые
    // входящие двигают курсор `last_seen_id` дальше неё — тогда синк своё
    // сообщение уже не вернёт, и после reload из кэша восстанавливалось
    // только то, что успел захватить случайный синк (пропадал документ с
    // подписью, `scripts/e2e_web_media_ttl.mjs`). Правки/удаление своих
    // сообщений догоняются по `updated_at` и перезаписывают запись
    saveHistoryRecord(entry);
    void flushHistoryQueue();
  }

  // Своё сообщение изменилось (правка/удаление, протокол v2 — без серверной
  // v1-строки): журнал сливается с выдачей полного синка, и старая запись
  // журнала откатила бы правку после reload
  function updateOwnJournalEntry(stored: WireStoredMessage) {
    if (!journalCache) return;
    const index = journalCache.findIndex((entry) => entry.id === stored.id);
    if (index < 0) return;
    if (stored.deleted) journalCache.splice(index, 1);
    else journalCache[index] = stored;
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
    notifyChange('blocked');
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

  // Прочитанное ЭТИМ устройством. Раньше жило только в памяти, поэтому после
  // перезагрузки непрочитанность считалась заново по серверному флагу: если
  // msg.chat.read не дошёл (кадр потерян, вкладку закрыли до ответа), бейдж
  // возвращался. Держим локальный журнал и объединяем его с серверным флагом.
  const READ_UUIDS_CAP = 5000;

  function loadReadUuids(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey('readuuids')) || '[]');
    } catch {
      return [];
    }
  }

  function saveReadUuids(uuids: string[]) {
    // Обрезаем сверху: список только растёт, а полезен лишь свежий хвост.
    const tail = uuids.length > READ_UUIDS_CAP ? uuids.slice(-READ_UUIDS_CAP) : uuids;
    try {
      localStorage.setItem(storageKey('readuuids'), JSON.stringify(tail));
    } catch {
      // квота исчерпана — переживём, серверный флаг остаётся источником истины
    }
  }

  // Постоянные инвайт-ссылки групп, полученные на этом устройстве:
  // group_id → { link, date }. Сервер не отдаёт уже созданный токен и не
  // умеет отзыв — без памяти каждая сессия плодила бы новую ссылку
  function loadInviteLinks(): Record<string, { link: string; date: number }> {
    try {
      return JSON.parse(localStorage.getItem(storageKey('invites')) || '{}');
    } catch {
      return {};
    }
  }

  function saveInviteLinks(map: Record<string, { link: string; date: number }>) {
    try {
      localStorage.setItem(storageKey('invites'), JSON.stringify(map));
    } catch {
      // квота — ссылка останется в памяти сессии
    }
  }

  // Очередь починки нерасшифрованного (conformance SYNC-2): uuid → число
  // попыток. Пока есть непрочитанное с попытками < потолка, курсор синка на
  // диск не пишем; исчерпавшее потолок отпускаем — иначе одно сообщение без
  // копии под наше устройство заставляло бы пересинхронизировать историю при
  // каждом входе.
  function loadRepairAttempts(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem(storageKey('repair')) || '{}');
    } catch {
      return {};
    }
  }

  function saveRepairAttempts(map: Record<string, number>) {
    try {
      if (Object.keys(map).length) localStorage.setItem(storageKey('repair'), JSON.stringify(map));
      else localStorage.removeItem(storageKey('repair'));
    } catch {
      // квота — переживём
    }
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
    notifyChange('folders');
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
    notifyChange('drafts');
  }

  // Черновики, сведённые журналом (T098): заменяют локальные целиком
  function replaceDrafts(drafts: Record<string, Record<string, unknown>>) {
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
    notifyChange('pinned');
  }

  function savePinnedList(list: string[]) {
    localStorage.setItem(storageKey('pinned'), JSON.stringify(list));
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
    notifyChange('archived');
  }

  function saveArchivedList(list: string[]) {
    localStorage.setItem(storageKey('archived'), JSON.stringify(list));
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
    notifyChange('notify');
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
    notifyChange('notify');
  }

  // `invites` намеренно НЕ стирается: сервер не умеет отзывать ссылки, и на
  // каждый новый вход создавал бы новый вечный токен группы. FR-011 требует
  // переиспользовать ссылку и между повторными входами на устройстве
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
    notifyChange('scheduled');
  }

  return {
    applyFromJournal,
    loadDirtyKinds,
    getDirtyRevision: () => dirtyRevision,
    clearDirtyKinds,
    applyJournalScheduled,
    listJournalScheduled,
    replaceDrafts,
    saveArchivedList,
    savePinnedList,
    setChangeListener: (listener?: (kind: LocalStateKind) => void) => {
      changeListener = listener;
    },
    setScheduledHooks: (hooks?: { gate: (opId: string) => Promise<boolean>; sent: (opId: string) => void }) => {
      scheduledGate = hooks?.gate;
      scheduledSent = hooks?.sent;
    },
    hydrate,
    reset,
    saveHistoryRecord,
    deleteHistoryRecord,
    loadHistoryRecords,
    saveSyncCursor,
    loadSyncCursor,
    appendOwnJournal,
    updateOwnJournalEntry,
    clearUserData,
    deleteScheduledMessages: removeScheduled,
    fetchScheduledHistory,
    loadArchived,
    loadBlocked,
    loadContacts,
    loadNonContacts,
    loadDeletedChats,
    loadUnreadMarks,
    loadReadUuids,
    loadRepairAttempts,
    markChatDeleted,
    unmarkChatDeleted,
    loadClearedUntil,
    saveClearedUntil,
    removeOwnJournalEntries,
    flushHistoryNow: flushHistoryQueue,
    loadDrafts,
    loadFolders,
    loadInviteLinks,
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
    saveReadUuids,
    saveRepairAttempts,
    saveDraft,
    saveFolders,
    saveInviteLinks,
    setArchived,
    setPinned,
    savePeerTtl,
    scheduleMessage,
    scheduleTtlDeletion,
    sendScheduledMessages,
  };
}
