import type { SendMessageParams } from '../../types';
import type { ApiChat, ApiMessage, ApiUpdate } from '../types';
import type { LocalContactInfo } from './contactInfo';
import type { ForwardOptions } from './forwardOptions';
import type { StickerRef } from './stickerLists';
import type { ParvaneStore } from './store';
import type { HistorySyncState } from './v2/history';
import type { HReadMark } from './v2/historyModel';
import type { WireStoredMessage } from './wire';

import { hasMediaContent, isAuthorHidden } from './forwardOptions';
import {
  forgetPersonal, hydratePersonal, MODEL_BACKED_PARTS, personalDropFromDisk, personalGet, personalIsModelBacked,
  personalRemove, personalSet, personalSetMemory, personalSetModelBacked, renamePersonal, takeLegacyLocal,
} from './personalStore';
import { SecureE2eStorage } from './secureStorage';
import { parseStickerRefs } from './stickerLists';
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
  // «Без звука» (`Content.silent` внутри `ScheduledMessage.content`)
  silent?: boolean;
  // Медиа/опрос/стикер нельзя восстановить из localStorage, поэтому полные
  // параметры живут только до конца текущей вкладки.
  params?: SendMessageParams;
  // Отложенная пересылка (A3) — тоже только во вкладке: исходное сообщение и параметры меню пересылки
  forward?: ScheduledForward;
};

export type ScheduledForward = {
  fromChat: ApiChat;
  toChat: ApiChat;
  message: ApiMessage;
  options: ForwardOptions;
};

// Вид локальных данных, изменённых пользователем (журнал личного состояния, T098)
export type LocalStateKind = 'folders' | 'blocked' | 'drafts' | 'scheduled' | 'archived' | 'pinned' | 'notify'
  | 'unread' | 'reaction' | 'packs' | 'contacts';

// Свой набор стикеров/эмодзи в журнале состояния (`state.v1.StickerPack`, PACK-3): id набора и ссылка на архив
// в облаке — поля `PackArchive` (как `pack_ref` сообщения: bytes — base64)
export type LocalStickerPack = {
  set_id: string;
  ref: {
    file_id: string; name?: string; count?: number; key?: string; nonce?: string; capability?: string;
    content_hash?: string; blob_domain?: string;
  };
  emoji?: boolean;
  added_ms?: string;
};

// Секреты блоба записи вида `packs` (C7-3): хранятся отдельно от зеркала в localStorage
const PACK_SECRETS = 'packsecrets';
type PackSecret = { key?: string; nonce?: string; capability?: string };

function packSecretOf(pack: LocalStickerPack): PackSecret | undefined {
  const { key, nonce, capability } = pack.ref;
  if (!key && !nonce && !capability) return undefined;
  const secret: PackSecret = {};
  if (key) secret.key = key;
  if (nonce) secret.nonce = nonce;
  if (capability) secret.capability = capability;
  return secret;
}

function stripPackSecret(pack: LocalStickerPack): LocalStickerPack {
  const {
    key, nonce, capability, ...ref
  } = pack.ref;
  return { ...pack, ref };
}

function withPackSecret(pack: LocalStickerPack, secret: PackSecret | undefined): LocalStickerPack {
  if (!secret || packSecretOf(pack)) return pack;
  return { ...pack, ref: { ...pack.ref, ...secret } };
}

// Быстрая реакция: эмодзи либо id собственного эмодзи (журнал состояния, `state.v1.QuickReaction`)
export type LocalQuickReaction = { emoji?: string; documentId?: string };

// Текстовое отложенное сообщение в виде для журнала личного состояния
export type JournalScheduled = {
  opId: string;
  chatId: string;
  scheduledAt: number;
  text?: string;
  entities?: SendMessageParams['entities'];
  silent?: boolean;
};

// «Отправить, когда будет в сети» (как desktop: `send_at_ms` = 0x7FFFFFFE × 1000, `Api::kScheduledUntilOnline`)
export const SCHEDULED_UNTIL_ONLINE = 0x7FFFFFFE;

/** Отложенные, которым пора: срок наступил, либо «когда в сети» — и собеседник в сети. */
export function selectDueScheduled<T extends { chatId: string; scheduledAt: number }>(
  queue: T[], nowSecs: number, isPeerOnline: (chatId: string) => boolean,
): T[] {
  return queue.filter((entry) => (entry.scheduledAt === SCHEDULED_UNTIL_ONLINE
    ? isPeerOnline(entry.chatId)
    : entry.scheduledAt <= nowSecs));
}

// Вид журнала личного состояния, которому принадлежит запись `personalStore` (T118)
const PART_KIND: Record<(typeof MODEL_BACKED_PARTS)[number], LocalStateKind> = {
  folders: 'folders',
  folders_all_index: 'folders',
  blocked: 'blocked',
  archived: 'archived',
  pinned: 'pinned',
  notify: 'notify',
  notifydefaults: 'notify',
  unreadpeers: 'unread',
  quickreaction: 'reaction',
  stickerpacks: 'packs',
  contacts: 'contacts',
  contactinfo: 'contacts',
};
// Виды, правленные до первой проекции модели в этой вкладке (запись `personalStore`, T118): их значение могло
// не нести того, что уже в журнале, — дописываются в журнал без удаления пропавшего
const PARTIAL_PART = 'statepartial';

function kindOfPart(part: string): LocalStateKind | undefined {
  return (PART_KIND as Record<string, LocalStateKind>)[part];
}

type LocalStateDependencies = {
  getStore: () => ParvaneStore;
  isAuthorized: () => boolean;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  buildLocalContent: (uuid: string, params: SendMessageParams) => ApiMessage['content'];
  sendMessage: (params: SendMessageParams, uuid?: string) => Promise<unknown>;
  // Собеседник чата сейчас в сети (присутствие v2) — для «Отправить, когда будет в сети»
  isPeerOnline?: (chatId: string) => boolean;
  /** T118: показ личного состояния модели без сети (журнал ещё не подключён) — в localState. */
  projectOffline?: () => Promise<void>;
  forwardMessages?: (params: {
    fromChat: ApiChat; toChat: ApiChat; messages: ApiMessage[];
  } & ForwardOptions) => Promise<unknown>;
};

const SCHEDULED_CHECK_INTERVAL_MS = 5000;
// Показ личного состояния модели без сети при запуске (T118): дольше не ждём — виды придут проекцией позже
const OFFLINE_PROJECTION_WAIT_MS = 4000;
const SCHEDULED_ID_BASE = 1_000_001;
const RECORD_SAVE_DELAY_MS = 300;
// Маркеры «прочитано до» прежних сборок (с spec 035 T114 — в модели движка)
const READ_MARK_PREFIX = 'rm:';
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const JOURNAL_MAX_ENTRIES = 5000;
// Запись журнала исходящих на одно сообщение (perf A6)
const JOURNAL_PREFIX = 'j:';

// Записи с личным содержимым, ключи которых несут не адрес, а числовой id аккаунта либо ничего (пути папок «Знаний»,
// набранные строки и словарь правок быстрого ввода «Плана»): по адресу их не найти — при выходе стираются по префиксу
const DEVICE_PERSONAL_PREFIXES = [
  'parvane:knowledge-collapsed', 'parvane:knowledge-graph-folders', 'parvane:quick-history:', 'parvane:quick-learned:',
];

export function createLocalState(deps: LocalStateDependencies) {
  const scheduledQueue: ScheduledEntry[] = [];
  let isScheduledLoaded = false;
  let scheduledNextId = SCHEDULED_ID_BASE;

  const storageKey = (part: string) => `parvane:${part}:${deps.getStore().self}`;
  // spec 035 T046 (PV-020): личные данные — в хранилище движка (`personalStore.ts`), чтение — из памяти после
  // `hydrate()`; в localStorage остаются только служебные флаги (`statedirty`, `repair`)
  // spec 035 T118: виды, которые ведёт журнал модели (`MODEL_BACKED_PARTS`), после первого переноса — проекция
  // показа модели в памяти: запись из журнала (`applyFromJournal`) на диск не пишется, на диске вид лежит, только
  // пока несёт правку пользователя, ещё не принятую журналом
  const personal = {
    getItem: (part: string) => personalGet(deps.getStore().self, part),
    setItem: (part: string, value: string) => {
      if (isProjectionWrite(part)) personalSetMemory(deps.getStore().self, part, value);
      else personalSet(deps.getStore().self, part, value);
    },
    removeItem: (part: string) => {
      if (isProjectionWrite(part)) personalSetMemory(deps.getStore().self, part, undefined);
      else personalRemove(deps.getStore().self, part);
    },
  };
  // Проекция модели уже была в этой вкладке (показ модели — в памяти целиком)
  let isProjected = false;
  // Показ модели без сети при запуске — одна попытка на вход
  let offlineProjection: Promise<void> | undefined;

  function isModelBacked() {
    return personalIsModelBacked(deps.getStore().self);
  }

  function isProjectionWrite(part: string) {
    if (!applyingJournal || !isModelBacked()) return false;
    const kind = kindOfPart(part);
    return Boolean(kind) && !loadDirtyKinds().includes(kind);
  }

  // Журнал личного состояния (T098) слушает правки пользователя; запись
  // пришедшего из журнала (applyingJournal) слушателя не будит
  let changeListener: ((kind: LocalStateKind) => void) | undefined;
  let ownSentListener: ((entry: WireStoredMessage) => void) | undefined;
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
    if (isModelBacked() && !isProjected) markPartial(kind);
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
    if (loadPartialKinds().length) personal.removeItem(PARTIAL_PART);
    if (isModelBacked()) dropSyncedFromDisk();
  }

  function loadPartialKinds(): LocalStateKind[] {
    try {
      const kinds = JSON.parse(personal.getItem(PARTIAL_PART) || '[]') as LocalStateKind[];
      return Array.isArray(kinds) ? kinds : [];
    } catch {
      return [];
    }
  }

  function markPartial(kind: LocalStateKind) {
    const kinds = loadPartialKinds();
    if (!kinds.includes(kind)) personal.setItem(PARTIAL_PART, JSON.stringify([...kinds, kind]));
  }

  // Принятое журналом — только в памяти: записи видов без несохранённых правок стираются с диска
  function dropSyncedFromDisk() {
    const dirty = loadDirtyKinds();
    personalDropFromDisk(
      deps.getStore().self, MODEL_BACKED_PARTS.filter((part) => !dirty.includes(PART_KIND[part])),
    );
  }

  /** Показ модели спроецирован (T118). `attached` — журнал подключён и сведён: виды переходят к модели, их
   * прежние записи на диске стираются (кроме несущих несохранённую правку). */
  function markProjected(attached: boolean) {
    isProjected = true;
    if (!attached) return;
    personalSetModelBacked(deps.getStore().self);
    dropSyncedFromDisk();
  }

  /** Значения видов `MODEL_BACKED_PARTS` уже целиком в памяти (проекция была либо журнал их ещё не ведёт). */
  function isPersonalComplete() {
    return isProjected || !isModelBacked();
  }

  function notifyChange(kind: LocalStateKind, isDirtyDeferred?: boolean) {
    if (applyingJournal) return;
    if (!isDirtyDeferred) markDirty(kind);
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
  // Журнал исходящих: в памяти — списком по времени, на диске — записями
  // `j:<uuid>` (perf A6): раньше каждая отправка переписывала весь журнал
  // (до 5 000 сообщений) одной записью
  let journalCache: WireStoredMessage[] | undefined;
  let isJournalLoaded = false;
  // Записи журнала идут одна за другой: удаление не должно обогнать запись
  let journalChain: Promise<void> = Promise.resolve();
  let draftsCache: Record<string, Record<string, unknown>> | undefined;
  // Ключи записей вида `packs` (C7-3): загруженные из шифрованного хранилища (undefined — ещё нет) и записанные до
  // загрузки (с перечнем наборов той записи)
  let packSecrets: Record<string, PackSecret> | undefined;
  let pendingPackSecrets: Record<string, PackSecret> = {};
  let packSetsBeforeLoad: Set<string> | undefined;
  let packSecretsChain: Promise<void> = Promise.resolve();
  let draftsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  // Правка черновиков пользователем ждёт записи на диск, чтобы стать отметкой «не в журнале»
  let areDraftsDirty = false;

  function compareJournal(a: WireStoredMessage, b: WireStoredMessage) {
    return (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  /** Срезать журнал до JOURNAL_MAX_ENTRIES; возвращает id срезанных. */
  function trimJournal(): string[] {
    if (!journalCache || journalCache.length <= JOURNAL_MAX_ENTRIES) return [];
    return journalCache.splice(0, journalCache.length - JOURNAL_MAX_ENTRIES).map((m) => m.id);
  }

  function queueJournalWrite(op: (storage: SecureE2eStorage) => Promise<void>): Promise<void> {
    const pending = secureStorage();
    if (!pending) return journalChain;
    journalChain = journalChain.then(() => pending).then(op).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn(`[parvane] журнал исходящих: запись не сохранена: ${String(err)}`);
    });
    return journalChain;
  }

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
    await hydratePersonal(deps.getStore().self);
    // T118: виды журнала после первого переноса на диске не лежат — показ модели без сети, до подключения
    if (isModelBacked() && !isProjected && deps.projectOffline) {
      offlineProjection ||= Promise.race([
        deps.projectOffline().catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, OFFLINE_PROJECTION_WAIT_MS);
        }),
      ]);
      await offlineProjection;
    }
    if (isJournalLoaded && draftsCache && packSecrets) return;
    const storage = await secureStorage();
    if (!storage) {
      journalCache = journalCache || [];
      draftsCache = draftsCache || {};
      return;
    }
    if (!packSecrets) await hydratePackSecrets(storage);
    if (!isJournalLoaded) {
      isJournalLoaded = true;
      // Записи `j:<uuid>` (perf A6) + разовый перенос прежних форматов: одной
      // записи `journal` целиком и localStorage `hist`
      const rows = await storage.loadRecordsByPrefix<WireStoredMessage>(JOURNAL_PREFIX);
      const legacyRecord = (await storage.loadRecord<WireStoredMessage[]>('journal')) || [];
      const legacyLocal = readLegacyJson<WireStoredMessage[]>(storageKey('hist'), []);
      // Дописанное до загрузки (сразу после входа) уже на диске и свежее строк
      const known = new Set((journalCache || []).map((m) => m.id));
      const merged = [...(journalCache || [])];
      const migrated: WireStoredMessage[] = [];
      rows.forEach((m) => {
        if (known.has(m.id)) return;
        known.add(m.id);
        merged.push(m);
      });
      [...legacyRecord, ...legacyLocal].forEach((m) => {
        if (known.has(m.id)) return;
        known.add(m.id);
        merged.push(m);
        migrated.push(m);
      });
      merged.sort(compareJournal);
      journalCache = merged;
      const trimmed = trimJournal();
      if (migrated.length) await storage.saveRecords(migrated.map((m) => [`${JOURNAL_PREFIX}${m.id}`, m]));
      if (trimmed.length) await storage.deleteRecords(trimmed.map((id) => `${JOURNAL_PREFIX}${id}`));
      if (legacyRecord.length) await storage.deleteRecord('journal').catch(() => undefined);
      if (legacyLocal.length) takeLegacyLocal(deps.getStore().self, 'hist');
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
        takeLegacyLocal(deps.getStore().self, 'scheduled');
      }
    }
    if (!draftsCache) {
      const stored = await storage.loadRecord<Record<string, Record<string, unknown>>>('drafts');
      const legacy = readLegacyJson<Record<string, Record<string, unknown>>>(storageKey('drafts'), {});
      draftsCache = stored || {};
      if (Object.keys(legacy).length) {
        draftsCache = { ...legacy, ...draftsCache };
        await storage.saveRecord('drafts', draftsCache);
        takeLegacyLocal(deps.getStore().self, 'drafts');
      }
    }
  }

  function scheduleRecordSave(name: 'drafts') {
    if (draftsSaveTimer) return;
    draftsSaveTimer = setTimeout(() => {
      draftsSaveTimer = undefined;
      saveDraftsRecord();
    }, RECORD_SAVE_DELAY_MS);
  }

  // Отметка «правка черновиков не в журнале» ставится только после записи черновиков на диск: синхронная отметка
  // при отложенной записи переживала перезагрузку без самих черновиков, и подключение журнала досылало пустой список —
  // стирало черновик и на сервере (e2e content_ux)
  function saveDraftsRecord() {
    const isDirty = areDraftsDirty;
    areDraftsDirty = false;
    void secureStorage()?.then((storage) => storage.saveRecord('drafts', draftsCache || {}))
      .then(() => {
        if (isDirty) markDirty('drafts');
      })
      .catch(() => undefined);
  }

  // ── кэш строк прежних сборок (шифрованные записи m:<uuid>, маркеры rm:) ───────────────
  // С spec 035 T114 строки истории и маркеры хранит модель движка; прежний кэш читается один раз — для разового
  // переноса в модель (`historyRows`, T115) — и стирается

  // Уход со страницы: черновики — сразу; журнал исходящих пишется записью на сообщение сразу при отправке (perf A6),
  // строки истории — пачками модели
  function flushRecordSaves() {
    if (draftsSaveTimer) {
      clearTimeout(draftsSaveTimer);
      draftsSaveTimer = undefined;
      saveDraftsRecord();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      flushRecordSaves();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushRecordSaves();
      }
    });
  }

  // Удалённые «для меня» личные чаты (по адресу пира): не показывать в списке,
  // пока в чате нет ни одного сообщения (новое входящее возвращает чат). Без
  // этого пир, известный по составу общей группы, всплывал бы пустым чатом
  function loadDeletedChats(): string[] {
    try {
      return JSON.parse(personal.getItem('deletedchats') || '[]');
    } catch {
      return [];
    }
  }

  function markChatDeleted(address: string) {
    const list = loadDeletedChats();
    if (!list.includes(address)) personal.setItem('deletedchats', JSON.stringify([...list, address]));
  }

  // Граница очистки чата «у себя» (T145): адрес → время (мс), не позже
  // которого сообщения скрыты. В v2 она едет журналом личного состояния на
  // остальные свои устройства (в v1 — нотис `cleared` с id сообщений)
  function loadClearedUntil(): Record<string, number> {
    try {
      const map = JSON.parse(personal.getItem('cleareduntil') || '{}') as Record<string, number>;
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
      personal.setItem('cleareduntil', JSON.stringify(map));
    } catch {
      // Квота/приватный режим: граница живёт до перезагрузки
    }
    return true;
  }

  function unmarkChatDeleted(address: string) {
    const list = loadDeletedChats();
    if (list.includes(address)) {
      personal.setItem('deletedchats', JSON.stringify(list.filter((item) => item !== address)));
    }
  }

  /** Кэш строк прежних сборок (только для разового переноса в модель). */
  async function loadHistoryRecords(): Promise<WireStoredMessage[]> {
    const storage = await secureStorage();
    if (!storage) return [];
    return storage.loadRecordsByPrefix<WireStoredMessage>('m:');
  }

  /** Прежний кэш строк перенесён в модель — стереть. */
  async function dropLegacyHistory(uuids: string[], addresses: string[]) {
    const storage = await secureStorage();
    if (!storage) return;
    await storage.deleteRecords([...uuids.map((id) => `m:${id}`), ...addresses.map((a) => `${READ_MARK_PREFIX}${a}`)]);
  }

  function resetSecureCaches() {
    journalCache = undefined;
    isJournalLoaded = false;
    journalChain = Promise.resolve();
    draftsCache = undefined;
    packSecrets = undefined;
    pendingPackSecrets = {};
    packSetsBeforeLoad = undefined;
    packSecretsChain = Promise.resolve();
    securePromise = undefined;
    secureUser = '';
    if (draftsSaveTimer) clearTimeout(draftsSaveTimer);
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
    const persistable = scheduledQueue.filter((entry) => !entry.params && !entry.forward);
    void secureStorage()?.then((storage) => {
      if (!storage) return undefined;
      return storage.saveRecord('scheduled', persistable).then(() => {
        try {
          takeLegacyLocal(deps.getStore().self, 'scheduled');
        } catch {
          // приватный режим
        }
      });
    }).catch(() => undefined);
  }

  function buildScheduledApiMessage(entry: ScheduledEntry): ApiMessage {
    if (entry.forward) return buildScheduledForward(entry, entry.forward);
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
      isSilent: entry.silent || undefined,
      replyInfo: entry.replyToMsgId ? { type: 'message', replyToMsgId: entry.replyToMsgId } : undefined,
    };
  }

  function buildScheduledForward(entry: ScheduledEntry, forward: ScheduledForward): ApiMessage {
    const { message, options } = forward;
    const content = options.noCaptions && hasMediaContent(message.content) && message.content.text
      ? (({ text: _caption, ...rest }) => rest)(message.content)
      : message.content;
    return {
      id: entry.id,
      chatId: entry.chatId,
      content,
      date: entry.scheduledAt,
      isOutgoing: true,
      senderId: deps.selfId(),
      isScheduled: true,
      forwardInfo: isAuthorHidden(options) ? undefined : {
        date: message.date,
        isChannelPost: false,
        fromChatId: message.senderId || forward.fromChat.id,
      },
    };
  }

  function scheduleForward(forward: ScheduledForward, scheduledAt: number) {
    loadScheduledQueue();
    const entry: ScheduledEntry = {
      id: scheduledNextId++, chatId: forward.toChat.id, scheduledAt, forward,
    };
    scheduledQueue.push(entry);
    deps.sendUpdate({
      '@type': 'newScheduledMessage', chatId: entry.chatId, id: entry.id, message: buildScheduledApiMessage(entry),
    });
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

  // Записи, которые уже отправляются: ворота журнала асинхронны, а проверка срока идёт по интервалу —
  // без отметки тот же срок успевал бы сработать второй раз и отправить сообщение дважды
  const firingScheduled = new Set<string>();

  async function fireScheduled(entry: ScheduledEntry) {
    const firingKey = `${entry.chatId}:${entry.id}`;
    if (firingScheduled.has(firingKey)) return;
    firingScheduled.add(firingKey);
    try {
      await fireScheduledOnce(entry);
    } finally {
      firingScheduled.delete(firingKey);
    }
  }

  async function fireScheduledOnce(entry: ScheduledEntry) {
    // Отложенное из журнала: первое устройство, заметившее срок, отправляет его
    // с op_id отложенного; другое устройство уже отправило — только убрать
    if (entry.opId && scheduledGate && !(await scheduledGate(entry.opId))) {
      applyFromJournal(() => removeScheduled(entry.chatId, [entry.id]));
      return;
    }
    if (entry.forward) {
      applyFromJournal(() => removeScheduled(entry.chatId, [entry.id]));
      const { fromChat, toChat, message, options } = entry.forward;
      await deps.forwardMessages?.({
        fromChat, toChat, messages: [message], ...options,
      });
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
        isSilent: entry.silent || undefined,
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
      silent: params.isSilent || undefined,
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
      silent: entry.silent,
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
          if (existing.scheduledAt === item.scheduledAt && existing.text === item.text
            && Boolean(existing.silent) === Boolean(item.silent)) return;
          existing.scheduledAt = item.scheduledAt;
          existing.text = item.text;
          existing.entities = item.entities;
          existing.silent = item.silent;
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
          silent: item.silent,
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
    const due = selectDueScheduled(scheduledQueue, now, (chatId) => Boolean(deps.isPeerOnline?.(chatId)));
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
    // До hydrate (сразу после логина) копим в памяти — hydrate сольёт со строками
    journalCache = journalCache || [];
    journalCache.push(entry);
    const trimmed = trimJournal();
    // Своё исходящее пишем на диск сразу, без отложенной записи: вкладка,
    // закрытая в первую секунду после отправки, теряла сообщение — запись,
    // начатая в pagehide, не успевает (шифрование и IndexedDB асинхронны), а
    // сервер своё сообщение не вернёт. Запись — одна, своя для сообщения
    void queueJournalWrite(async (storage) => {
      await storage.saveRecord(`${JOURNAL_PREFIX}${entry.id}`, entry);
      if (trimmed.length) await storage.deleteRecords(trimmed.map((id) => `${JOURNAL_PREFIX}${id}`));
    });
    // Своё исходящее — сразу строкой модели (spec 035 T114) и журнала истории (spec 033), со сдвигом маркера чата:
    // сервер не шлёт эхо отправителю
    ownSentListener?.(entry);
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
    void queueJournalWrite((storage) => (stored.deleted
      ? storage.deleteRecord(`${JOURNAL_PREFIX}${stored.id}`)
      : storage.saveRecord(`${JOURNAL_PREFIX}${stored.id}`, stored)));
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
    await queueJournalWrite((storage) => storage.deleteRecords(uuids.map((id) => `${JOURNAL_PREFIX}${id}`)));
  }

  function loadPeerTtl(): Record<string, number> {
    try {
      return JSON.parse(personal.getItem('ttl') || '{}');
    } catch {
      return {};
    }
  }

  function savePeerTtl(map: Record<string, number>) {
    personal.setItem('ttl', JSON.stringify(map));
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
      return JSON.parse(personal.getItem('blocked') || '[]');
    } catch {
      return [];
    }
  }

  function saveBlocked(list: string[]) {
    personal.setItem('blocked', JSON.stringify(list));
    notifyChange('blocked');
  }

  function isBlocked(address: string) {
    return loadBlocked().includes(address);
  }

  // Явно добавленные контакты (адреса) — телефонной книги у Parvane нет
  function loadContacts(): string[] {
    try {
      return JSON.parse(personal.getItem('contacts') || '[]');
    } catch {
      return [];
    }
  }

  function saveContacts(list: string[]) {
    personal.setItem('contacts', JSON.stringify(list));
    notifyChange('contacts');
  }

  // «Избранные» и «Недавние» стикеры (A6): ссылки «набор + стикер», только на этом устройстве. Недавних ещё не
  // было (null) — показываются первые встроенные, как раньше
  function loadStickerRefs(kind: 'favestickers' | 'recentstickers'): StickerRef[] | undefined {
    try {
      const raw = personal.getItem(kind);
      // eslint-disable-next-line no-null/no-null -- getItem отдаёт null, если записи нет
      return raw === null ? undefined : parseStickerRefs(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  function saveStickerRefs(kind: 'favestickers' | 'recentstickers', refs: StickerRef[]) {
    try {
      personal.setItem(kind, JSON.stringify(refs));
    } catch {
      // квота — список живёт до перезагрузки
    }
  }

  // Порядок наборов стикеров («Динамический порядок наборов», B12): id наборов, первым — последний отправленный
  function loadStickerSetOrder(): string[] {
    try {
      const raw = JSON.parse(personal.getItem('stickersetorder') || '[]') as unknown;
      return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  function saveStickerSetOrder(order: string[]) {
    try {
      personal.setItem('stickersetorder', JSON.stringify(order));
    } catch {
      // квота — порядок живёт до перезагрузки
    }
  }

  // Своё имя контакта и заметка (CONTACT-1) по адресу; между своими устройствами — журналом (`contacts`)
  function loadContactInfo(): Record<string, LocalContactInfo> {
    try {
      const map = JSON.parse(personal.getItem('contactinfo') || '{}') as unknown;
      return map && typeof map === 'object' && !Array.isArray(map) ? map as Record<string, LocalContactInfo> : {};
    } catch {
      return {};
    }
  }

  function saveContactInfo(map: Record<string, LocalContactInfo>) {
    personal.setItem('contactinfo', JSON.stringify(map));
    notifyChange('contacts');
  }

  function loadNonContacts(): string[] {
    try {
      return JSON.parse(personal.getItem('noncontacts') || '[]');
    } catch {
      return [];
    }
  }

  function saveNonContacts(list: string[]) {
    personal.setItem('noncontacts', JSON.stringify(list));
  }

  // «Отметить непрочитанным»: адреса чатов с ручной пометкой; между своими
  // устройствами — журналом личного состояния (`unread_marks`)
  function loadUnreadMarks(): string[] {
    try {
      return JSON.parse(personal.getItem('unreadpeers') || '[]');
    } catch {
      return [];
    }
  }

  function saveUnreadMarks(addresses: string[]) {
    personal.setItem('unreadpeers', JSON.stringify(addresses));
    notifyChange('unread');
  }

  // Пометки прежних версий хранились по id чата (хеш адреса, обратное соответствие
  // только в памяти) — переносятся один раз, когда чаты уже известны
  function takeLegacyUnreadMarks(): string[] {
    try {
      const ids = JSON.parse(personal.getItem('unreadmarks') || '[]') as string[];
      personal.removeItem('unreadmarks');
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  function loadQuickReaction(): LocalQuickReaction | undefined {
    try {
      const raw = personal.getItem('quickreaction');
      const value = raw ? JSON.parse(raw) as LocalQuickReaction : undefined;
      return value?.emoji || value?.documentId ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function saveQuickReaction(reaction: LocalQuickReaction | undefined) {
    if (reaction) {
      personal.setItem('quickreaction', JSON.stringify(reaction));
    } else {
      personal.removeItem('quickreaction');
    }
    notifyChange('reaction');
  }

  // C7-3 (ревью 7 ноя 2026): зеркало вида `packs` журнала личного состояния (наборы PACK-3, свои GIF GIF-1) несёт
  // ключ, nonce и capability блоба. В localStorage — только без них (копия профиля или XSS давали бы ключи вместе с
  // доступом к шифртексту); секреты — записью `packsecrets` шифрованного хранилища (A0028-7), в памяти — после
  // hydrate(). Записанное до hydrate() держится в `pendingPackSecrets` и сводится с загруженным
  function loadStickerPackMirror(): LocalStickerPack[] {
    try {
      const list = JSON.parse(personal.getItem('stickerpacks') || '[]') as unknown;
      return Array.isArray(list)
        ? (list as LocalStickerPack[]).filter((p) => typeof p?.set_id === 'string' && p.ref?.file_id)
        : [];
    } catch {
      return [];
    }
  }

  function writeStickerPackMirror(packs: LocalStickerPack[]) {
    try {
      personal.setItem('stickerpacks', JSON.stringify(packs.map(stripPackSecret)));
    } catch {
      // Квота: запись уйдёт в журнал из памяти вкладки, пока она жива
    }
  }

  function loadStickerPacks(): LocalStickerPack[] {
    const secrets = { ...packSecrets, ...pendingPackSecrets };
    return loadStickerPackMirror().map((pack) => withPackSecret(pack, secrets[pack.set_id]));
  }

  function saveStickerPacks(packs: LocalStickerPack[]) {
    const known = { ...packSecrets, ...pendingPackSecrets };
    const next: Record<string, PackSecret> = {};
    packs.forEach((pack) => {
      // Запись без ключей (список прочитан до hydrate) не затирает сохранённые ключи набора
      const secret = packSecretOf(pack) || known[pack.set_id];
      if (secret) next[pack.set_id] = secret;
    });
    if (packSecrets) {
      packSecrets = next;
    } else {
      pendingPackSecrets = next;
      packSetsBeforeLoad = new Set(packs.map((pack) => pack.set_id));
    }
    writeStickerPackMirror(packs);
    if (packSecrets) persistPackSecrets();
    notifyChange('packs');
  }

  function persistPackSecrets() {
    const pending = secureStorage();
    const value = packSecrets || {};
    packSecretsChain = packSecretsChain.then(() => pending).then((storage) => storage?.saveRecord(PACK_SECRETS, value))
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[parvane] ключи наборов стикеров не сохранены: ${String(err)}`);
      });
  }

  /** Дождаться записи ключей наборов на диск (тесты, выход). */
  function flushPackSecrets() {
    return packSecretsChain;
  }

  // Загрузка ключей (hydrate) и разовый перенос: прежние записи localStorage с ключами — в шифрованное хранилище,
  // затем localStorage переписывается без них
  async function hydratePackSecrets(storage: SecureE2eStorage) {
    const stored = (await storage.loadRecord<Record<string, PackSecret>>(PACK_SECRETS)) || {};
    const mirror = loadStickerPackMirror();
    const inline: Record<string, PackSecret> = {};
    mirror.forEach((pack) => {
      const secret = packSecretOf(pack);
      if (secret) inline[pack.set_id] = secret;
    });
    const merged: Record<string, PackSecret> = {};
    const present = packSetsBeforeLoad || new Set(mirror.map((pack) => pack.set_id));
    present.forEach((setId) => {
      const secret = pendingPackSecrets[setId] || inline[setId] || stored[setId];
      if (secret) merged[setId] = secret;
    });
    packSecrets = merged;
    pendingPackSecrets = {};
    packSetsBeforeLoad = undefined;
    if (JSON.stringify(merged) !== JSON.stringify(stored)) await storage.saveRecord(PACK_SECRETS, merged);
    if (Object.keys(inline).length) writeStickerPackMirror(mirror);
  }

  // Прежний учёт прочитанного (список uuid в localStorage, до spec 033) — только для разового переноса в маркеры
  // «прочитано до» (журнал истории, FR-024); после переноса стирается
  const LEGACY_READ_PART = 'readuuids';

  function takeLegacyReadUuids(): string[] {
    try {
      const list = JSON.parse(localStorage.getItem(storageKey(LEGACY_READ_PART)) || '[]') as unknown;
      return Array.isArray(list) ? list.filter((uuid): uuid is string => typeof uuid === 'string') : [];
    } catch {
      return [];
    }
  }

  function dropLegacyReadUuids() {
    try {
      localStorage.removeItem(storageKey(LEGACY_READ_PART));
    } catch {
      // приватный режим — останется до выхода
    }
  }

  // Квитанции прочтения собеседникам, ещё не принятые сервером (READ-1 п. 3): адрес → uuid; повтор до успеха
  // переживает перезагрузку
  function loadPendingReceipts(): Record<string, string[]> {
    try {
      const map = JSON.parse(personal.getItem('receipts') || '{}') as unknown;
      return map && typeof map === 'object' && !Array.isArray(map) ? map as Record<string, string[]> : {};
    } catch {
      return {};
    }
  }

  function savePendingReceipts(map: Record<string, string[]>) {
    try {
      if (Object.keys(map).length) personal.setItem('receipts', JSON.stringify(map));
      else personal.removeItem('receipts');
    } catch {
      // квота — повтор живёт до перезагрузки
    }
  }

  // ── журнал истории (spec 033): курсор, очередь записи; маркеры прежних сборок (`rm:`) — для переноса ─────────

  async function loadReadMarks(): Promise<Record<string, HReadMark>> {
    const storage = await secureStorage();
    if (!storage) return {};
    const rows = await storage.loadRecordsByPrefix<{ address: string; mark: HReadMark }>(READ_MARK_PREFIX);
    return Object.fromEntries(rows.filter((row) => row?.address && row.mark).map((row) => [row.address, row.mark]));
  }

  async function loadHistorySync(): Promise<HistorySyncState | undefined> {
    return (await secureStorage())?.loadRecord<HistorySyncState>('hsync');
  }

  async function saveHistorySync(value: HistorySyncState) {
    await (await secureStorage())?.saveRecord('hsync', value);
  }

  async function loadHistoryOutbox<T>(): Promise<T | undefined> {
    return (await secureStorage())?.loadRecord<T>('hsync-outbox');
  }

  async function saveHistoryOutbox(value: unknown) {
    await (await secureStorage())?.saveRecord('hsync-outbox', value);
  }

  // Постоянные инвайт-ссылки групп, полученные на этом устройстве:
  // group_id → { link, date }. Сервер не отдаёт уже созданный токен и не
  // умеет отзыв — без памяти каждая сессия плодила бы новую ссылку
  function loadInviteLinks(): Record<string, { link: string; date: number }> {
    try {
      return JSON.parse(personal.getItem('invites') || '{}');
    } catch {
      return {};
    }
  }

  function saveInviteLinks(map: Record<string, { link: string; date: number }>) {
    try {
      personal.setItem('invites', JSON.stringify(map));
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
      return JSON.parse(personal.getItem('folders') || '[]');
    } catch {
      return [];
    }
  }

  function saveFolders(folders: { id: number; [key: string]: unknown }[]) {
    personal.setItem('folders', JSON.stringify(folders));
    notifyChange('folders');
  }

  // Место «Все чаты» среди папок (0 — первыми): Telegram даёт двигать его только с Premium, у нас — всем.
  // Хранится отдельно от списка папок (их записи журнала не трогаются); в журнал уходит как id 0 в folder_order.
  function loadAllFolderIndex(): number {
    try {
      const value = Number(personal.getItem('folders_all_index') || '0');
      return Number.isInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function saveAllFolderIndex(index: number) {
    try {
      personal.setItem('folders_all_index', String(Math.max(0, Math.floor(index))));
    } catch {
      // квота — переживём
    }
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
    if (!applyingJournal) areDraftsDirty = true;
    scheduleRecordSave('drafts');
    notifyChange('drafts', true);
  }

  // Черновики, сведённые журналом (T098): заменяют локальные целиком
  function replaceDrafts(drafts: Record<string, Record<string, unknown>>) {
    draftsCache = drafts;
    scheduleRecordSave('drafts');
  }

  // Закреплённые чаты (адреса пиров, порядок = порядок пина) и архив
  function loadPinned(): string[] {
    try {
      return JSON.parse(personal.getItem('pinned') || '[]');
    } catch {
      return [];
    }
  }

  function setPinned(address: string, shouldPin: boolean) {
    const pinned = loadPinned().filter((a) => a !== address);
    if (shouldPin) pinned.unshift(address);
    personal.setItem('pinned', JSON.stringify(pinned));
    notifyChange('pinned');
  }

  function savePinnedList(list: string[]) {
    personal.setItem('pinned', JSON.stringify(list));
  }

  function loadArchived(): string[] {
    try {
      return JSON.parse(personal.getItem('archived') || '[]');
    } catch {
      return [];
    }
  }

  function setArchived(address: string, shouldArchive: boolean) {
    const archived = loadArchived().filter((a) => a !== address);
    if (shouldArchive) archived.push(address);
    personal.setItem('archived', JSON.stringify(archived));
    notifyChange('archived');
  }

  function saveArchivedList(list: string[]) {
    personal.setItem('archived', JSON.stringify(list));
  }

  // Notify-настройки чатов (mute/превью) по адресу пира/группы
  function loadNotifyExceptions(): Record<string, Record<string, unknown>> {
    try {
      return JSON.parse(personal.getItem('notify') || '{}');
    } catch {
      return {};
    }
  }

  function saveNotifyExceptions(map: Record<string, Record<string, unknown>>) {
    personal.setItem('notify', JSON.stringify(map));
    notifyChange('notify');
  }

  // Дефолты уведомлений по типам чатов (users/groups/channels)
  function loadNotifyDefaults(): Record<string, Record<string, unknown>> {
    try {
      return JSON.parse(personal.getItem('notifydefaults') || '{}');
    } catch {
      return {};
    }
  }

  function saveNotifyDefaults(map: Record<string, Record<string, unknown>>) {
    personal.setItem('notifydefaults', JSON.stringify(map));
    notifyChange('notify');
  }

  // `invites` намеренно НЕ стирается: сервер не умеет отзывать ссылки, и на
  // каждый новый вход создавал бы новый вечный токен группы. FR-011 требует
  // переиспользовать ссылку и между повторными входами на устройстве
  // Полный выход: все записи этого аккаунта в localStorage — `parvane:<что>:<адрес>` и с адресом посередине.
  // Раньше стирался перечень из двенадцати видов, и после выхода оставались названия групп, собеседники,
  // ссылки-приглашения, отметки прочтения (WEB-10). Адрес двоеточий не содержит — граница записи надёжна
  function clearUserData(user: string) {
    const suffix = `:${user}`;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('parvane:') && (key.endsWith(suffix) || key.includes(`${suffix}:`)
        || DEVICE_PERSONAL_PREFIXES.some((prefix) => key.startsWith(prefix)))) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
    forgetPersonal(user);
    resetSecureCaches();
    void SecureE2eStorage.clearRecords(user).catch(() => undefined);
  }

  // Смена ника (spec 026): переносы адресов «прежний → новый» (свои и собеседников). Чат остаётся прежним:
  // стор сводит адреса цепочки к одному id
  function loadRenames(): [string, string][] {
    try {
      const list = JSON.parse(personal.getItem('renames') || '[]');
      return Array.isArray(list) ? list.filter((p): p is [string, string] => Array.isArray(p)
        && typeof p[0] === 'string' && typeof p[1] === 'string') : [];
    } catch {
      return [];
    }
  }

  // `owner` — чей список (по умолчанию текущий пользователь; при своей смене ника — новый адрес)
  function saveRename(oldAddress: string, newAddress: string, owner?: string) {
    const user = owner || deps.getStore().self;
    let list: [string, string][];
    try {
      list = (JSON.parse(personalGet(user, 'renames') || '[]') as [string, string][])
        .filter(([from]) => from !== oldAddress);
    } catch {
      list = [];
    }
    list.push([oldAddress, newAddress]);
    personalSet(user, 'renames', JSON.stringify(list));
  }

  // Своя смена ника: записи localStorage `parvane:<что>:<прежний адрес>` — под новым адресом
  function moveUserData(oldUser: string, newUser: string) {
    renamePersonal(oldUser, newUser);
    const suffix = `:${oldUser}`;
    const moves: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('parvane:')) continue;
      if (key.endsWith(suffix)) moves.push([key, `${key.slice(0, -suffix.length)}:${newUser}`]);
      else if (key.includes(`${suffix}:`)) moves.push([key, key.replace(`${suffix}:`, `:${newUser}:`)]);
    }
    // Сначала пишем все новые ключи и только потом убираем старые: переполненная квота посреди
    // переноса не должна оставить половину данных под новым адресом, а половину потерять
    const written: string[] = [];
    try {
      for (const [from, to] of moves) {
        const value = localStorage.getItem(from);
        if (typeof value !== 'string') continue;
        localStorage.setItem(to, value);
        written.push(to);
      }
    } catch {
      written.forEach((key) => {
        try {
          localStorage.removeItem(key);
        } catch {
          // откат best effort
        }
      });
      resetSecureCaches();
      return;
    }
    for (const [from] of moves) localStorage.removeItem(from);
    resetSecureCaches();
  }

  // Смена аккаунта: очереди/кэши прежнего пользователя не должны утечь в
  // ключи нового (persist считается от текущего self)
  function reset() {
    isProjected = false;
    offlineProjection = undefined;
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
    loadPartialKinds,
    markProjected,
    isPersonalComplete,
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
    setOwnSentListener: (listener?: (entry: WireStoredMessage) => void) => {
      ownSentListener = listener;
    },
    setScheduledHooks: (hooks?: { gate: (opId: string) => Promise<boolean>; sent: (opId: string) => void }) => {
      scheduledGate = hooks?.gate;
      scheduledSent = hooks?.sent;
    },
    hydrate,
    reset,
    loadHistoryRecords,
    dropLegacyHistory,
    appendOwnJournal,
    updateOwnJournalEntry,
    clearUserData,
    loadRenames,
    saveRename,
    moveUserData,
    deleteScheduledMessages: removeScheduled,
    fetchScheduledHistory,
    loadArchived,
    loadBlocked,
    loadContacts,
    loadContactInfo,
    loadStickerRefs,
    loadStickerSetOrder,
    loadNonContacts,
    loadDeletedChats,
    loadUnreadMarks,
    takeLegacyReadUuids,
    loadPendingReceipts,
    savePendingReceipts,
    dropLegacyReadUuids,
    loadReadMarks,
    loadHistorySync,
    saveHistorySync,
    loadHistoryOutbox,
    saveHistoryOutbox,
    loadRepairAttempts,
    markChatDeleted,
    unmarkChatDeleted,
    loadClearedUntil,
    saveClearedUntil,
    removeOwnJournalEntries,
    loadDrafts,
    loadFolders,
    loadAllFolderIndex,
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
    saveContactInfo,
    saveStickerRefs,
    saveStickerSetOrder,
    saveNonContacts,
    saveUnreadMarks,
    takeLegacyUnreadMarks,
    loadQuickReaction,
    saveQuickReaction,
    loadStickerPacks,
    saveStickerPacks,
    flushPackSecrets,
    saveRepairAttempts,
    saveDraft,
    saveFolders,
    saveAllFolderIndex,
    saveInviteLinks,
    setArchived,
    setPinned,
    savePeerTtl,
    scheduleMessage,
    scheduleForward,
    scheduleTtlDeletion,
    sendScheduledMessages,
  };
}
