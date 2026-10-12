// Хранилище «Знаний»: заметки — обычные `.md` в папке «Знания» личного диска облака (зашифрованные блобы,
// дерево — домен `cloud.v1`). Тексты читаются при открытии раздела и держатся в памяти; указатель связей
// строится из содержимого. Сохранение сводит правки с двух устройств построчно; при расхождении рядом
// создаётся копия «… (конфликт …)» — молча ничего не теряется.

import type { CloudDriveState } from '../../../api/parvane/cloudDrive';
import type { CloudNode } from '../cloud/cloudModel';
import type { NotesIndex, NoteSource } from './notesModel';

import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';
import {
  getCloudData, getNodes, loadCloud, refreshCloud, renameCloudNode, trashCloudNodes,
} from '../cloud/cloudStore';
import { toDayKey } from '../planner/plannerModel';
import { getPlannerState, updatePlanner } from '../planner/plannerStore';
import { mergeNotes } from './notesMerge';
import {
  buildNotesIndex, dailyNoteTemplate, dailyNoteTitle, normalizeNoteTitle, parseNote, renameLinks,
} from './notesModel';
import {
  applyNoteTasks, applyPlannerToNote, getNoteTasks, markerOfTask, planNoteTasks,
} from './notesTasks';
import {
  buildWelcomeNote, WELCOME_NOTE_NODE_ID, WELCOME_VAULT_NODE_ID, type WelcomeLang,
} from './notesWelcome';

export type NoteEntry = NoteSource & {
  // Версия содержимого, от которой идёт следующая правка
  fileId: string;
  isDaily: boolean;
};
export type CanvasEntry = { id: string; title: string; text: string; fileId: string };
export type NotesStatus = 'loading' | 'ready';
export type NotesNotice = { code: 'conflict' | 'failed' | 'merged'; title: string; at: number };

export type NotesOptions = { welcomeLang: WelcomeLang; vaultName: string };

type TextResult = { text: string; fileId: string } | undefined;
type DriveCheck = 'unknown' | 'none' | 'synced';
type WriteResult = { ok: boolean; node?: string; fileId?: string; conflict?: string } | undefined;

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Папка хранилища в корне личного диска; создаётся под названием на языке интерфейса
const VAULT_NAMES = ['Знания', 'Knowledge'];
const DAILY_FOLDER_NAMES = ['Ежедневные', 'Daily'];
const NOTE_EXTENSION = '.md';
const CANVAS_EXTENSION = '.canvas';
const CANVAS_MIME = 'application/json';
const ROOT = 'root';
const LOAD_PARALLEL = 4;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const [getNotes, setNotes] = createSignal<NoteEntry[]>([]);
const [getCanvases, setCanvases] = createSignal<CanvasEntry[]>([]);
const [getNotesStatus, setNotesStatus] = createSignal<NotesStatus>('loading');
const [getNotesNotice, setNotesNotice] = createSignal<NotesNotice | undefined>(undefined);
// Первая заметка, созданная в этой сессии: раздел открывает её сам
const [getWelcomeNoteId, setWelcomeNoteId] = createSignal<string | undefined>(undefined);

export {
  getNotes, getCanvases, getNotesStatus, getNotesNotice, getWelcomeNoteId,
};

let isListening = false;
let syncQueue: Promise<void> = Promise.resolve();
let cachedIndex: { notes: NoteEntry[]; index: NotesIndex } | undefined;
// Метки пунктов, которым уже выдавалась задача: исчезнувшая в «Плане» задача такой метки — удаление
const knownMarkers = new Set<string>();
const texts = new Map<string, { fileId: string; text: string }>();
let notesUserId: string | undefined;
let welcomeOptions: NotesOptions | undefined;
// Первая заметка: идёт проверка и создание (правки хранилища её ждут) либо вопрос для этой сессии решён
let welcomeRun: Promise<void> | undefined;
let isWelcomeSettled = false;

function rootIdOf(data = getCloudData()) {
  return data?.rootId;
}

function findVault(nodes: CloudNode[]) {
  return nodes.find((node) => (
    node.kind === 'folder' && !node.parent && !node.trashed && VAULT_NAMES.includes(node.name)
  ));
}

// Папка хранилища в любом состоянии, в том числе в корзине: хранилище у аккаунта уже заводили
function hasVaultTrace(nodes: CloudNode[]) {
  return nodes.some((node) => (
    node.id === WELCOME_VAULT_NODE_ID || node.id === WELCOME_NOTE_NODE_ID
    || (node.kind === 'folder' && !node.parent && VAULT_NAMES.includes(node.name))
  ));
}

function pathOf(nodes: CloudNode[], node: CloudNode, vaultId: string) {
  const parts: string[] = [];
  let parent = node.parent ? nodes.find(({ id }) => id === node.parent) : undefined;
  while (parent && parent.id !== vaultId) {
    parts.unshift(parent.name);
    parent = parent.parent ? nodes.find(({ id }) => id === parent!.parent) : undefined;
  }
  // Узел вне папки хранилища в заметки не входит
  return parent ? parts.join('/') : undefined;
}

async function readText(node: CloudNode): Promise<{ fileId: string; text: string } | undefined> {
  const fileId = node.blob?.fileId;
  if (!fileId) return undefined;
  const cached = texts.get(node.id);
  if (cached?.fileId === fileId) return cached;
  const container = rootIdOf();
  const result = await callParvane('parvaneCloudReadText', { container, node: node.id })
    .catch(() => undefined) as TextResult;
  if (!result) return cached;
  texts.set(node.id, result);
  return result;
}

async function syncFromCloud(data: CloudDriveState | undefined) {
  // Облако ещё не прочитано — ждём; прочитано, но личного диска нет (создастся первой заметкой) — пусто
  if (!data) return;
  const rootId = rootIdOf(data);
  const nodes = rootId ? getNodes(rootId, data) : [];
  const vault = findVault(nodes);
  const files = !vault ? [] : nodes
    .filter((node) => node.kind === 'file' && !node.trashed)
    .map((node) => ({ node, folder: pathOf(nodes, node, vault.id) }))
    .filter((item): item is { node: CloudNode; folder: string } => item.folder !== undefined);
  const notes: NoteEntry[] = [];
  const canvases: CanvasEntry[] = [];
  for (let i = 0; i < files.length; i += LOAD_PARALLEL) {
    await Promise.all(files.slice(i, i + LOAD_PARALLEL).map(async ({ node, folder }) => {
      const isNote = node.name.endsWith(NOTE_EXTENSION);
      if (!isNote && !node.name.endsWith(CANVAS_EXTENSION)) return;
      const content = await readText(node);
      if (!content) return;
      const title = node.name.slice(0, -(isNote ? NOTE_EXTENSION : CANVAS_EXTENSION).length);
      if (!isNote) {
        canvases.push({
          id: node.id, title, text: content.text, fileId: content.fileId,
        });
        return;
      }
      notes.push({
        id: node.id,
        title,
        folder,
        text: content.text,
        updatedAt: node.mtime,
        fileId: content.fileId,
        isDaily: DAY_KEY.test(title),
      });
    }));
  }
  notes.sort((a, b) => b.updatedAt - a.updatedAt || (a.title < b.title ? -1 : 1));
  canvases.sort((a, b) => (a.title < b.title ? -1 : 1));
  notes.forEach((note) => parseNote(note.text).tasks.forEach((task) => {
    if (task.marker && getNoteTasks(getPlannerState(), note.id).some((t) => markerOfTask(t) === task.marker)) {
      knownMarkers.add(task.marker);
    }
  }));
  setNotes(notes);
  setCanvases(canvases);
  setNotesStatus('ready');
  if (!hasVaultTrace(nodes)) startWelcome();
  else isWelcomeSettled = true;
}

// Первая заметка хранилища — один раз на аккаунт. Создаётся, только когда всё сразу верно:
// (1) в личном диске нет и следа папки хранилища (нет её и в корзине) — у аккаунта с заметками, как и у
//     аккаунта, удалившего первую заметку, папка есть;
// (2) дерево диска только что сверено с сервером (`parvaneCloudCheckDrive`): непривязанное устройство,
//     устройство без связи и устройство, до которого ещё не дошёл диск другого своего устройства, получают
//     `unknown` и ничего не создают; диска нет вовсе (`none`) — он создаётся этой же правкой;
// (3) папка и заметка создаются одной правкой с постоянными идентификаторами: два устройства, успевшие
//     пройти (1) и (2) одновременно, дают один и тот же узел, а стёртая из корзины папка с таким
//     идентификатором заново не создаётся, пока движок помнит её стёртой.
function startWelcome() {
  const options = welcomeOptions;
  if (!options || welcomeRun || isWelcomeSettled) return;
  const userId = notesUserId;
  welcomeRun = (async () => {
    const check = await callParvane('parvaneCloudCheckDrive').catch(() => undefined) as DriveCheck | undefined;
    // Судить рано: попытка повторится со следующим изменением облака
    if (!check || check === 'unknown' || userId !== notesUserId) return;
    const data = await refreshCloud();
    const rootId = rootIdOf(data);
    if (!data || Boolean(rootId) !== (check === 'synced')) return;
    isWelcomeSettled = true;
    if (rootId && hasVaultTrace(getNodes(rootId, data))) return;
    const welcome = buildWelcomeNote(options.welcomeLang);
    const result = await callParvane('parvaneCloudWriteText', {
      container: ROOT,
      name: `${welcome.title}${NOTE_EXTENSION}`,
      text: welcome.text,
      newNodeId: WELCOME_NOTE_NODE_ID,
      newFolder: { id: WELCOME_VAULT_NODE_ID, name: options.vaultName },
    }).catch(() => undefined) as WriteResult;
    if (!result?.ok || !result.node) {
      // Запись не удалась целиком (ни папки, ни заметки) — попробуем при следующем изменении облака
      isWelcomeSettled = false;
      return;
    }
    texts.set(result.node, { fileId: result.fileId!, text: welcome.text });
    setWelcomeNoteId(result.node);
    // Дерево с новой папкой — до того, как продолжатся правки, ждавшие эту проверку
    await refreshCloud();
  })().catch(() => undefined).finally(() => {
    welcomeRun = undefined;
  });
}

/** Раздел показал первую заметку — больше её открывать не нужно. */
export function consumeWelcomeNote() {
  setWelcomeNoteId(undefined);
}

function queueSync() {
  syncQueue = syncQueue.then(() => syncFromCloud(getCloudData())).catch(() => undefined);
  return syncQueue;
}

/** Открыть хранилище: дерево облака → тексты заметок; дальше следует за изменениями облака.
 * `options` — язык и название папки для первой заметки нового хранилища. */
export function loadNotes(userId?: string, options?: NotesOptions) {
  if (notesUserId !== userId) {
    notesUserId = userId;
    isWelcomeSettled = false;
    setWelcomeNoteId(undefined);
  }
  welcomeOptions = options || welcomeOptions;
  void loadCloud(userId);
  if (!isListening) {
    isListening = true;
    getCloudData.subscribe(() => {
      void queueSync();
    });
  }
  return queueSync();
}

export function getNotesIndex(notes = getNotes()): NotesIndex {
  if (cachedIndex?.notes !== notes) cachedIndex = { notes, index: buildNotesIndex(notes) };
  return cachedIndex.index;
}

export function findNoteByTitle(title: string, notes = getNotes()) {
  const key = normalizeNoteTitle(title);
  return notes.find((note) => normalizeNoteTitle(note.title) === key);
}

function notify(code: NotesNotice['code'], title: string) {
  setNotesNotice({ code, title, at: Date.now() });
}

async function ensureFolder(name: string, parent?: string): Promise<string | undefined> {
  // Папку хранилища может прямо сейчас создавать первая заметка — второй такой же папки не нужно
  await welcomeRun;
  const rootId = rootIdOf();
  const names = parent ? [name] : VAULT_NAMES;
  const find = () => getNodes(rootId).find((node) => (
    node.kind === 'folder' && !node.trashed && (node.parent || undefined) === parent
    && (parent ? node.name === name : names.includes(node.name))
  ));
  const existing = find();
  if (existing) return existing.id;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const result = await callParvane('parvaneCloudApply', {
    container: ROOT,
    ops: [{
      op: 'create', id, kind: 'folder', parent, name,
    }],
  }).catch(() => undefined) as { ok: boolean } | undefined;
  if (!result?.ok) return undefined;
  await refreshCloud();
  return find()?.id || id;
}

function uniqueTitle(title: string, notes = getNotes()) {
  const clean = title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Без названия';
  if (!findNoteByTitle(clean, notes)) return clean;
  for (let n = 2; ; n++) {
    if (!findNoteByTitle(`${clean} ${n}`, notes)) return `${clean} ${n}`;
  }
}

/** Новая заметка в папке хранилища; возвращает её id. Название занято — добавляется номер. */
export async function createNote(
  title: string, vaultName: string, options: { text?: string; folderName?: string } = {},
): Promise<string | undefined> {
  const vault = await ensureFolder(vaultName);
  if (!vault) return undefined;
  const parent = options.folderName ? await ensureFolder(options.folderName, vault) : vault;
  const name = uniqueTitle(title);
  const text = options.text ?? `# ${name}\n\n`;
  const result = await callParvane('parvaneCloudWriteText', {
    container: ROOT, parent, name: `${name}${NOTE_EXTENSION}`, text,
  }).catch(() => undefined) as WriteResult;
  if (!result?.ok || !result.node) {
    notify('failed', name);
    return undefined;
  }
  texts.set(result.node, { fileId: result.fileId!, text });
  await refreshCloud();
  await queueSync();
  return result.node;
}

/** Заметка дня: открыть существующую либо создать по шаблону. */
export async function openDailyNote(day: string, vaultName: string, dailyFolderName: string) {
  const title = dailyNoteTitle(day);
  const existing = findNoteByTitle(title);
  if (existing) return existing.id;
  const folderName = DAILY_FOLDER_NAMES.includes(dailyFolderName) ? dailyFolderName : DAILY_FOLDER_NAMES[0];
  return createNote(title, vaultName, { text: dailyNoteTemplate(day), folderName });
}

function quickContext() {
  const { settings } = getPlannerState();
  const now = new Date();
  return {
    today: toDayKey(now),
    nowMinutes: now.getHours() * 60 + now.getMinutes(),
    dayStart: settings.dayStart,
    dayEnd: settings.dayEnd,
  };
}

async function writeNote(note: NoteEntry, text: string, expectedFileId?: string): Promise<WriteResult> {
  return callParvane('parvaneCloudWriteText', {
    container: rootIdOf() || ROOT, node: note.id, name: `${note.title}${NOTE_EXTENSION}`, text, expectedFileId,
  }).catch(() => undefined) as Promise<WriteResult>;
}

/** Сохранить текст заметки. Пункты с датой получают метки и становятся задачами «Плана». */
export async function saveNote(noteId: string, draft: string, vaultName: string): Promise<boolean> {
  const note = getNotes().find(({ id }) => id === noteId);
  if (!note) return false;
  const planned = planNoteTasks(draft, quickContext());
  let text = planned.text;
  if (text === note.text) return true;
  let result = await writeNote(note, text, note.fileId);
  if (result?.ok && result.conflict !== undefined) {
    // Заметку тем временем изменило другое устройство: сводим построчно от общей версии
    const merged = mergeNotes(note.text, text, result.conflict);
    if (merged.hasConflict) {
      await createNote(`${note.title} (конфликт ${new Date().toLocaleString()})`, vaultName, { text: result.conflict });
      notify('conflict', note.title);
    } else {
      text = merged.text;
      notify('merged', note.title);
    }
    result = await writeNote(note, text, result.fileId);
    // Второе расхождение подряд — пишем свою версию: чужая уже сохранена копией либо сведена
    if (result?.ok && result.conflict !== undefined) result = await writeNote(note, text);
  }
  if (!result?.ok || !result.fileId) {
    notify('failed', note.title);
    return false;
  }
  texts.set(note.id, { fileId: result.fileId, text });
  const tasks = planNoteTasks(text, quickContext()).tasks;
  tasks.forEach(({ marker }) => knownMarkers.add(marker));
  const probe = structuredClone(getPlannerState());
  if (applyNoteTasks(probe, note.id, tasks)) {
    updatePlanner((state) => {
      applyNoteTasks(state, note.id, tasks);
    });
  }
  setNotes(getNotes().map((entry) => (entry.id === note.id
    ? {
      ...entry, text, fileId: result.fileId!, updatedAt: Date.now(),
    } : entry)));
  void refreshCloud();
  return true;
}

/** Галочки и удаления из «Плана» → в заметки (вызывается при изменении «Плана» и после загрузки). */
export async function applyPlannerToNotes(vaultName: string) {
  const state = getPlannerState();
  for (const note of getNotes()) {
    const next = applyPlannerToNote(note.text, getNoteTasks(state, note.id), knownMarkers);
    if (next !== note.text) await saveNote(note.id, next, vaultName);
  }
}

/** Переименовать заметку и поправить ссылки на неё в остальных. */
export async function renameNote(noteId: string, title: string, vaultName: string) {
  const note = getNotes().find(({ id }) => id === noteId);
  const rootId = rootIdOf();
  const node = getNodes(rootId).find(({ id }) => id === noteId);
  const next = uniqueTitle(title, getNotes().filter(({ id }) => id !== noteId));
  if (!note || !node || !rootId || next === note.title) return false;
  if (!(await renameCloudNode(rootId, node, `${next}${NOTE_EXTENSION}`))) return false;
  await queueSync();
  for (const other of getNotes()) {
    const text = renameLinks(other.text, note.title, next);
    if (text !== other.text) await saveNote(other.id, text, vaultName);
  }
  return true;
}

/** В корзину облака; задачи «Плана» из её пунктов остаются. */
export async function deleteNote(noteId: string) {
  const rootId = rootIdOf();
  const node = getNodes(rootId).find(({ id }) => id === noteId);
  if (!rootId || !node) return false;
  const isDone = await trashCloudNodes(rootId, [node]);
  await queueSync();
  return isDone;
}

/** Холст: создать либо сохранить (`canvasId` не задан — новый). */
export async function saveCanvas(title: string, text: string, vaultName: string, canvasId?: string) {
  const vault = await ensureFolder(vaultName);
  if (!vault) return undefined;
  const existing = canvasId ? getCanvases().find(({ id }) => id === canvasId) : undefined;
  const result = await callParvane('parvaneCloudWriteText', {
    container: rootIdOf() || ROOT,
    parent: vault,
    node: existing?.id,
    name: `${existing?.title || title}${CANVAS_EXTENSION}`,
    text,
    mime: CANVAS_MIME,
  }).catch(() => undefined) as WriteResult;
  if (!result?.ok || !result.node) {
    notify('failed', title);
    return undefined;
  }
  texts.set(result.node, { fileId: result.fileId!, text });
  if (existing) {
    setCanvases(getCanvases().map((entry) => (entry.id === existing.id
      ? { ...entry, text, fileId: result.fileId! } : entry)));
  } else {
    await refreshCloud();
    await queueSync();
  }
  return result.node;
}
