// «Заметки»: очередь несохранённых текстов и расхождения правок (spec 041, хвосты D; spec 040 T9). Хранится в
// шифрованном хранилище устройства (`SecureE2eStorage`, записи `notes-outbox:<узел>` и `notes-conflict:<узел>`) —
// переживает перезагрузку и стирается вместе с хранилищем аккаунта (`deviceWipe.ts`). Здесь — только память,
// запись и сигналы; когда отправлять и как сводить, решает `notesStore.ts`.

import type { SecureE2eStorage } from '../../../api/parvane/secureStorage';

import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { createSignal } from '../../../util/signals';

// Текст, который не ушёл в облако: `base` и `baseFileId` — версия, от которой шла правка (общая основа для
// сведения, если заметку тем временем изменило другое устройство)
export type QueuedNoteText = {
  node: string;
  title: string;
  base: string;
  baseFileId: string;
  text: string;
  at: number;
};

// Расхождение правок: моя версия записана в заметку, их — копией `copyId`; `base` — общая основа
export type NoteConflict = {
  node: string;
  title: string;
  copyId?: string;
  base: string;
  mine: string;
  theirs: string;
  at: number;
};

type StorageGetter = () => Promise<SecureE2eStorage | undefined>;

const OUTBOX_PREFIX = 'notes-outbox:';
const CONFLICT_PREFIX = 'notes-conflict:';

const queued = new Map<string, QueuedNoteText>();
const conflicts = new Map<string, NoteConflict>();
const [getNotesUnsent, setNotesUnsent] = createSignal<ReadonlySet<string>>(new Set());
const [getNoteConflicts, setNoteConflicts] = createSignal<ReadonlyMap<string, NoteConflict>>(new Map());

export { getNotesUnsent, getNoteConflicts };

let storageOf: StorageGetter | undefined;
let loadRun: Promise<void> | undefined;
// Записи идут по одной, в порядке правок: запись старой версии не перебивает новую
let writes: Promise<unknown> = Promise.resolve();

function publish() {
  setNotesUnsent(new Set(queued.keys()));
  setNoteConflicts(new Map(conflicts));
}

function persist(run: (storage: SecureE2eStorage) => Promise<unknown>) {
  const getter = storageOf;
  writes = writes.then(async () => {
    const storage = await getter?.();
    if (storage && getter === storageOf) await run(storage);
  }).catch(() => undefined);
  return writes;
}

/** Новый аккаунт либо стирание: память очереди пуста, хранилище — новое. */
export function resetNotesOutbox(getter?: StorageGetter) {
  storageOf = getter;
  loadRun = undefined;
  queued.clear();
  conflicts.clear();
  publish();
}

/** Прочитать очередь и расхождения с устройства (один раз на аккаунт). */
export function loadNotesOutbox() {
  const getter = storageOf;
  loadRun ||= (async () => {
    const storage = await getter?.();
    if (getter !== storageOf) return;
    if (!storage) {
      // Хранилище ещё не открыто (движок поднимается) — прочитать при следующем проходе
      loadRun = undefined;
      return;
    }
    const [texts, found] = await Promise.all([
      storage.loadRecordsByPrefix<QueuedNoteText>(OUTBOX_PREFIX).catch(() => []),
      storage.loadRecordsByPrefix<NoteConflict>(CONFLICT_PREFIX).catch(() => []),
    ]);
    if (getter !== storageOf) return;
    texts.forEach((item) => {
      // Правка этой сессии новее записи с диска
      if (item?.node && typeof item.text === 'string' && !queued.has(item.node)) queued.set(item.node, item);
    });
    found.forEach((item) => {
      if (item?.node && typeof item.mine === 'string' && !conflicts.has(item.node)) conflicts.set(item.node, item);
    });
    publish();
  })();
  return loadRun;
}

export function getQueuedText(node: string) {
  return queued.get(node);
}

export function listQueuedTexts() {
  return [...queued.values()];
}

export function queueNoteText(item: QueuedNoteText) {
  queued.set(item.node, item);
  publish();
  return persist((storage) => storage.saveRecord(`${OUTBOX_PREFIX}${item.node}`, item));
}

/** Текст ушёл (либо заменён более новым отправленным) — из очереди. `text` — только если в очереди он же. */
export function dropQueuedText(node: string, text?: string) {
  const item = queued.get(node);
  if (!item || (text !== undefined && item.text !== text)) return undefined;
  queued.delete(node);
  publish();
  return persist((storage) => storage.deleteRecord(`${OUTBOX_PREFIX}${node}`));
}

export function getNoteConflict(node: string) {
  return conflicts.get(node);
}

export function saveNoteConflict(item: NoteConflict) {
  conflicts.set(item.node, item);
  publish();
  return persist((storage) => storage.saveRecord(`${CONFLICT_PREFIX}${item.node}`, item));
}

export function dropNoteConflict(node: string) {
  if (!conflicts.delete(node)) return undefined;
  publish();
  return persist((storage) => storage.deleteRecord(`${CONFLICT_PREFIX}${node}`));
}

if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => resetNotesOutbox());
}
