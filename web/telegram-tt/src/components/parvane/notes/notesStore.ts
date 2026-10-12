// Хранилище «Знаний»: заметки — обычные `.md` в папке «Знания» личного диска облака (зашифрованные блобы,
// дерево — домен `cloud.v1`). Тексты читаются при открытии раздела и держатся в памяти; указатель связей
// строится из содержимого. Сохранение сводит правки с двух устройств построчно; при расхождении рядом
// создаётся копия «… (конфликт …)» — молча ничего не теряется.

import type { CloudDriveState } from '../../../api/parvane/cloudDrive';
import type { CloudNode } from '../cloud/cloudModel';
import type { FolderSubmitError, NoteFolder } from './notesFolders';
import type { GuideDrive, GuideLang, GuideMode } from './notesGuide';
import type { NotesIndex, NoteSource } from './notesModel';

import { createSignal } from '../../../util/signals';
import { callApi } from '../../../api/gramjs';
import {
  getCloudData, getNodes, loadCloud, moveCloudNodes, refreshCloud, renameCloudNode, trashCloudNodes,
} from '../cloud/cloudStore';
import { toDayKey } from '../planner/plannerModel';
import { getPlannerState, updatePlanner } from '../planner/plannerStore';
import { parseCanvas, serializeCanvas } from './notesCanvas';
import { freeCanvasTitle, renameCanvasNote } from './notesCanvasGraph';
import { checkFolderName, folderContents, listNoteFolders } from './notesFolders';
import {
  buildGuideMarker, findGuideOverview, GUIDE_MARKER_MIME, GUIDE_MARKER_NAME, GUIDE_MARKER_NODE_ID, hasGuideMarker,
  planGuide,
} from './notesGuide';
import { mergeNotes } from './notesMerge';
import {
  buildNotesIndex, dailyNoteTemplate, dailyNoteTitle, normalizeNoteTitle, parseNote, renameLinks,
} from './notesModel';
import {
  applyNoteTasks, applyPlannerToNote, getNoteTasks, markerOfTask, planNoteTasks,
} from './notesTasks';

export type NoteEntry = NoteSource & {
  // Версия содержимого, от которой идёт следующая правка
  fileId: string;
  isDaily: boolean;
};
export type CanvasEntry = { id: string; title: string; text: string; fileId: string };
export type NotesStatus = 'loading' | 'ready';
export type NotesNotice = {
  code: 'conflict' | 'failed' | 'merged' | 'folder-files' | 'guide-failed'; title: string; at: number;
};
// Итог записи с карточки холста: `restored` — заметки уже не было, текст лёг в новую заметку
export type NoteSaveResult = { status: 'saved' | 'failed' } | { status: 'restored'; id: string; title: string };
export type FolderDeleteResult = 'done' | 'has-notes' | 'has-files' | 'failed';

export type NotesOptions = { guideLang: GuideLang; vaultName: string };

type TextResult = { text: string; fileId: string } | undefined;
type GuideResult = { status: 'retry' | 'skipped' } | { status: 'done'; isFreshVault: boolean; overviewId?: string };
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
// Столько раз за сессию справка пробует создаться сама (сбой записи — повтор при следующем изменении облака)
const GUIDE_ATTEMPTS_MAX = 3;

const [getNotes, setNotes] = createSignal<NoteEntry[]>([]);
const [getCanvases, setCanvases] = createSignal<CanvasEntry[]>([]);
const [getNotesStatus, setNotesStatus] = createSignal<NotesStatus>('loading');
const [getNotesNotice, setNotesNotice] = createSignal<NotesNotice | undefined>(undefined);
// Папки хранилища (пустые тоже): список заметок показывает их заголовками
const [getNoteFolders, setNoteFolders] = createSignal<NoteFolder[]>([]);
// «Обзор» справки, созданной в этой сессии вместе с хранилищем: раздел открывает его сам
const [getGuideOpenId, setGuideOpenId] = createSignal<string | undefined>(undefined);

export {
  getNotes, getCanvases, getNotesStatus, getNotesNotice, getNoteFolders, getGuideOpenId,
};

let isListening = false;
let syncQueue: Promise<void> = Promise.resolve();
let cachedIndex: { notes: NoteEntry[]; index: NotesIndex } | undefined;
// Метки пунктов, которым уже выдавалась задача: исчезнувшая в «Плане» задача такой метки — удаление
const knownMarkers = new Set<string>();
const texts = new Map<string, { fileId: string; text: string }>();
let notesUserId: string | undefined;
let notesOptions: NotesOptions | undefined;
// Справка: идёт проверка и создание (создание папки хранилища её ждёт) либо вопрос для этой сессии решён
let guideRun: Promise<unknown> | undefined;
let isGuideSettled = false;
let guideAttempts = 0;

function rootIdOf(data = getCloudData()) {
  return data?.rootId;
}

function findVault(nodes: CloudNode[]) {
  return nodes.find((node) => (
    node.kind === 'folder' && !node.parent && !node.trashed && VAULT_NAMES.includes(node.name)
  ));
}

function newNodeId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
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
  setNoteFolders(vault ? listNoteFolders(nodes, vault.id) : []);
  setNotesStatus('ready');
  if (hasGuideMarker(nodes, VAULT_NAMES)) isGuideSettled = true;
  else startGuide();
}

// Справка Parvane — один раз на аккаунт (решение и перечень узлов — `planGuide`). Создаётся сама, когда:
// (1) в хранилище нет файла-отметки (нет его и в корзине): отметка ставится последней и остаётся, даже если
//     справку потом удалили, — второй раз сама она не создаётся ни на одном устройстве аккаунта;
// (2) дерево диска только что сверено с сервером (`parvaneCloudCheckDrive`): непривязанное устройство,
//     устройство без связи и устройство, до которого ещё не дошёл диск другого своего устройства, получают
//     `unknown` и ничего не создают; диска нет вовсе (`none`) — он создаётся первой же правкой;
// (3) узлы создаются с постоянными идентификаторами: два устройства, прошедшие (1) и (2) одновременно, дают
//     одни и те же папку, заметки и отметку — движок сводит их в один набор. Прерванное создание продолжается
//     при следующем открытии: дописывается только то, чего ещё нет.
function startGuide() {
  const options = notesOptions;
  if (!options || guideRun || isGuideSettled || guideAttempts >= GUIDE_ATTEMPTS_MAX) return;
  const userId = notesUserId;
  guideRun = (async () => {
    const check = await callParvane('parvaneCloudCheckDrive').catch(() => undefined) as GuideDrive | undefined;
    // Судить рано: попытка повторится со следующим изменением облака
    if (!check || check === 'unknown' || userId !== notesUserId) return;
    guideAttempts++;
    const result = await writeGuide('auto', check, options);
    if (result.status === 'retry' || userId !== notesUserId) return;
    isGuideSettled = true;
    if (result.status === 'done' && result.isFreshVault) setGuideOpenId(result.overviewId);
  })().catch(() => undefined).finally(() => {
    guideRun = undefined;
  });
}

async function writeGuide(mode: GuideMode, check: GuideDrive, options: NotesOptions): Promise<GuideResult> {
  const data = await refreshCloud();
  const rootId = rootIdOf(data);
  if (!data || Boolean(rootId) !== (check === 'synced')) return { status: 'retry' };
  const plan = planGuide({
    drive: check,
    nodes: rootId ? getNodes(rootId, data) : [],
    lang: options.guideLang,
    vaultName: options.vaultName,
    vaultNames: VAULT_NAMES,
    mode,
    makeId: newNodeId,
  });
  if (plan.action === 'skip') return { status: 'skipped' };
  if (plan.folders.length) {
    // Папки — одной правкой: либо появятся все, либо ни одной
    const result = await callParvane('parvaneCloudApply', {
      container: ROOT,
      ops: plan.folders.map(({ id, name, parent }) => ({
        op: 'create', id, kind: 'folder', parent, name,
      })),
    }).catch(() => undefined) as { ok: boolean } | undefined;
    if (!result?.ok) return { status: 'retry' };
    const fresh = await refreshCloud();
    const nodes = getNodes(rootIdOf(fresh), fresh);
    // Стёртая из корзины папка с постоянным идентификатором заново не появляется, пока движок помнит её
    // стёртой: справку этому аккаунту уже создавали — остаётся поставить отметку
    if (!nodes.some(({ id, trashed }) => id === plan.folderId && !trashed)) {
      if (!findVault(nodes)) return { status: 'skipped' };
      return (await writeGuideMarker(options)) ? { status: 'done', isFreshVault: false } : { status: 'retry' };
    }
  }
  let overviewId: string | undefined;
  for (const note of plan.notes) {
    const result = await callParvane('parvaneCloudWriteText', {
      container: ROOT,
      parent: plan.folderId,
      name: `${note.title}${NOTE_EXTENSION}`,
      text: note.text,
      newNodeId: note.nodeId,
    }).catch(() => undefined) as WriteResult;
    // Записанное остаётся; недостающее допишет следующая попытка
    if (!result?.ok || !result.node) return { status: 'retry' };
    texts.set(result.node, { fileId: result.fileId!, text: note.text });
    if (note.key === 'overview') overviewId = result.node;
  }
  if (plan.hasMarkerWrite && !(await writeGuideMarker(options))) return { status: 'retry' };
  // Дерево со справкой — до того, как продолжатся правки, ждавшие эту проверку
  await refreshCloud();
  return { status: 'done', isFreshVault: plan.isFreshVault, overviewId };
}

// Файл-отметка в корне хранилища. Узел с постоянным идентификатором мог быть стёрт из корзины — тогда
// отметка пишется обычным узлом: «справка уже была» узнаётся и по имени файла
async function writeGuideMarker(options: NotesOptions) {
  const write = async (nodeId?: string) => {
    const vault = findVault(getNodes(rootIdOf()));
    if (!vault) return false;
    const result = await callParvane('parvaneCloudWriteText', {
      container: ROOT,
      parent: vault.id,
      name: GUIDE_MARKER_NAME,
      text: buildGuideMarker(options.guideLang, Date.now()),
      mime: GUIDE_MARKER_MIME,
      newNodeId: nodeId,
    }).catch(() => undefined) as WriteResult;
    if (!result?.ok) return false;
    const data = await refreshCloud();
    return hasGuideMarker(getNodes(rootIdOf(data), data), VAULT_NAMES);
  };
  return (await write(GUIDE_MARKER_NODE_ID)) || write();
}

/** Справка по кнопке: недостающие заметки создаются заново, существующие не трогаются. Возвращает id «Обзора». */
export async function restoreGuide(): Promise<string | undefined> {
  const options = notesOptions;
  if (!options) return undefined;
  // Справку может прямо сейчас создавать само хранилище
  await guideRun;
  const existing = findGuideOverview(getNotes());
  if (existing) return existing.id;
  const run = (async () => {
    const check = await callParvane('parvaneCloudCheckDrive').catch(() => undefined) as GuideDrive | undefined;
    return check && check !== 'unknown' ? writeGuide('restore', check, options) : undefined;
  })().catch(() => undefined);
  guideRun = run;
  const result = await run;
  guideRun = undefined;
  await queueSync();
  const overview = findGuideOverview(getNotes());
  if (!result || result.status === 'retry' || !overview) {
    notify('guide-failed', '');
    return undefined;
  }
  return overview.id;
}

/** Раздел показал справку нового хранилища — больше её открывать не нужно. */
export function consumeGuideOpen() {
  setGuideOpenId(undefined);
}

function queueSync() {
  syncQueue = syncQueue.then(() => syncFromCloud(getCloudData())).catch(() => undefined);
  return syncQueue;
}

/** Открыть хранилище: дерево облака → тексты заметок; дальше следует за изменениями облака.
 * `options` — язык справки и название папки нового хранилища. */
export function loadNotes(userId?: string, options?: NotesOptions) {
  if (notesUserId !== userId) {
    notesUserId = userId;
    isGuideSettled = false;
    guideAttempts = 0;
    setGuideOpenId(undefined);
  }
  notesOptions = options || notesOptions;
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
  // Папку хранилища может прямо сейчас создавать справка — второй такой же папки не нужно
  if (!findVault(getNodes(rootIdOf()))) await guideRun;
  const rootId = rootIdOf();
  const names = parent ? [name] : VAULT_NAMES;
  const find = () => getNodes(rootId).find((node) => (
    node.kind === 'folder' && !node.trashed && (node.parent || undefined) === parent
    && (parent ? node.name === name : names.includes(node.name))
  ));
  const existing = find();
  if (existing) return existing.id;
  const id = newNodeId();
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

// Название как имя файла: без знаков, запрещённых в именах, и без лишних пробелов
function cleanTitle(title: string) {
  return title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function uniqueTitle(title: string, notes = getNotes()) {
  const clean = cleanTitle(title) || 'Без названия';
  if (!findNoteByTitle(clean, notes)) return clean;
  for (let n = 2; ; n++) {
    if (!findNoteByTitle(`${clean} ${n}`, notes)) return `${clean} ${n}`;
  }
}

/** Новая заметка в хранилище; возвращает её id. Название занято — добавляется номер.
 * `folderId` — папка хранилища, `folderName` — папка в корне хранилища по названию (создаётся, если её нет). */
export async function createNote(
  title: string, vaultName: string, options: { text?: string; folderName?: string; folderId?: string } = {},
): Promise<string | undefined> {
  const vault = await ensureFolder(vaultName);
  if (!vault) return undefined;
  const folderId = options.folderId && getNoteFolders().some(({ id }) => id === options.folderId)
    ? options.folderId : undefined;
  const parent = folderId || (options.folderName ? await ensureFolder(options.folderName, vault) : vault);
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

/**
 * Текст заметки дня без чтения всего хранилища (карточка на «Сегодня»): по дереву облака находится один
 * файл и читается только он. `data` — дерево облака (`loadCloud` его уже прочитал); пока дерева нет —
 * `undefined`, заметки дня нет — `{}`. Текст берётся из той же памяти, что у раздела «Знания»: после
 * правки заметки (версия файла сменилась) читается заново.
 */
export async function readDailyNote(
  day: string, data = getCloudData(),
): Promise<{ text?: string } | undefined> {
  if (!data) return undefined;
  const nodes = getNodes(rootIdOf(data), data);
  const vault = findVault(nodes);
  const name = `${dailyNoteTitle(day)}${NOTE_EXTENSION}`;
  const node = vault && nodes.find((item) => (
    item.kind === 'file' && !item.trashed && item.name === name && pathOf(nodes, item, vault.id) !== undefined
  ));
  if (!node) return {};
  const content = await readText(node);
  // Файл есть, а прочитать не вышло (нет связи): не «заметки нет»
  return content ? { text: content.text } : undefined;
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

// Правка и чужая версия заметки от общей основы: сводятся построчно; изменено одно и то же место — остаётся
// своя правка, чужая версия сохраняется рядом копией «… (конфликт …)»
async function reconcileNote(note: NoteEntry, base: string, mine: string, theirs: string, vaultName: string) {
  const merged = mergeNotes(base, mine, theirs);
  if (merged.hasConflict) {
    await createNote(`${note.title} (конфликт ${new Date().toLocaleString()})`, vaultName, { text: theirs });
    notify('conflict', note.title);
    return mine;
  }
  // Чужая версия ничего не добавила к своей — сводить было нечего
  if (merged.text !== mine) notify('merged', note.title);
  return merged.text;
}

/** Сохранить текст заметки. Пункты с датой получают метки и становятся задачами «Плана».
 * `baseText` — текст, с которого начата правка: если заметка с тех пор изменилась (другое устройство,
 * галочка из «Плана»), правка сводится с этими изменениями, а не затирает их. */
export async function saveNote(
  noteId: string, draft: string, vaultName: string, baseText?: string,
): Promise<boolean> {
  const note = getNotes().find(({ id }) => id === noteId);
  if (!note) return false;
  const planned = planNoteTasks(draft, quickContext());
  let text = planned.text;
  if (baseText !== undefined && baseText !== note.text && text !== note.text) {
    text = await reconcileNote(note, baseText, text, note.text, vaultName);
  }
  if (text === note.text) return true;
  let result = await writeNote(note, text, note.fileId);
  if (result?.ok && result.conflict !== undefined) {
    // Заметку тем временем изменило другое устройство: сводим построчно от общей версии
    text = await reconcileNote(note, note.text, text, result.conflict, vaultName);
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

/** Сохранить текст, набранный на карточке холста. Заметку за время правки могли удалить (с другого
 * устройства либо на вкладке «Заметки») — тогда набранное не теряется: заметка создаётся заново под тем же
 * названием (занятое получает номер) и в той же папке, если папка ещё есть. Удалённая заметка остаётся в
 * корзине облака как была. */
export async function saveNoteOrRestore(
  noteId: string, title: string, draft: string, vaultName: string, baseText?: string,
): Promise<NoteSaveResult> {
  const node = getNodes(rootIdOf()).find(({ id }) => id === noteId);
  const isAlive = Boolean(node && !node.trashed) && getNotes().some(({ id }) => id === noteId);
  if (isAlive) return { status: (await saveNote(noteId, draft, vaultName, baseText)) ? 'saved' : 'failed' };
  // Дерево облака ещё не прочитано — судить, удалена ли заметка, рано
  if (!getCloudData() || getNotesStatus() !== 'ready') return { status: 'failed' };
  const id = await createNote(title, vaultName, { text: draft, folderId: node?.parent || undefined });
  const created = id ? getNotes().find((note) => note.id === id) : undefined;
  return id ? { status: 'restored', id, title: created?.title || title } : { status: 'failed' };
}

/** Галочки и удаления из «Плана» → в заметки (вызывается при изменении «Плана» и после загрузки). */
export async function applyPlannerToNotes(vaultName: string) {
  const state = getPlannerState();
  for (const note of getNotes()) {
    const next = applyPlannerToNote(note.text, getNoteTasks(state, note.id), knownMarkers);
    if (next !== note.text) await saveNote(note.id, next, vaultName);
  }
}

/** Название, которое заметка получит при переименовании: без знаков, запрещённых в именах файлов; занятое
 * другой заметкой — с номером. */
export function freeNoteTitle(noteId: string, title: string) {
  return uniqueTitle(title, getNotes().filter(({ id }) => id !== noteId));
}

/** Переименовать заметку и поправить ссылки на неё в остальных заметках и её карточки на холстах. */
export async function renameNote(noteId: string, title: string, vaultName: string) {
  const note = getNotes().find(({ id }) => id === noteId);
  const rootId = rootIdOf();
  const node = getNodes(rootId).find(({ id }) => id === noteId);
  const next = freeNoteTitle(noteId, title);
  if (!note || !node || !rootId || next === note.title) return false;
  if (!(await renameCloudNode(rootId, node, `${next}${NOTE_EXTENSION}`))) return false;
  await queueSync();
  for (const other of getNotes()) {
    const text = renameLinks(other.text, note.title, next);
    if (text !== other.text) await saveNote(other.id, text, vaultName);
  }
  // Карточка холста хранит название заметки путём файла; повреждённый файл холста не переписывается
  for (const canvas of getCanvases()) {
    const parsed = parseCanvas(canvas.text);
    const doc = parsed.error ? parsed.doc : renameCanvasNote(parsed.doc, note.title, next);
    if (doc !== parsed.doc) await saveCanvas(canvas.title, serializeCanvas(doc), vaultName, canvas.id);
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

/** Новая папка в корне хранилища; папка с таким названием уже есть — возвращается она. */
export async function createNoteFolder(
  name: string, vaultName: string,
): Promise<{ id?: string; error?: FolderSubmitError }> {
  const clean = name.trim();
  if (checkFolderName(clean, []) === 'bad-name') return { error: 'bad-name' };
  const existing = getNoteFolders().find(({ path }) => path.toLowerCase() === clean.toLowerCase());
  if (existing) return { id: existing.id };
  const vault = await ensureFolder(vaultName);
  const id = vault && await ensureFolder(clean, vault);
  if (!id) return { error: 'failed' };
  await queueSync();
  return { id };
}

/** Перенести заметку в папку хранилища (`folderId` не задан — «Без папки»). Узел остаётся тем же: ссылки по
 * названию, карточки холстов (название и id заметки) и задачи «Плана» из её пунктов переноса не замечают. */
export async function moveNote(noteId: string, folderId?: string) {
  const rootId = rootIdOf();
  const nodes = getNodes(rootId);
  const node = nodes.find(({ id }) => id === noteId);
  const target = folderId ? getNoteFolders().find(({ id }) => id === folderId)?.id : findVault(nodes)?.id;
  if (!rootId || !node || !target) return false;
  if (node.parent === target) return true;
  const isDone = await moveCloudNodes(rootId, [node], target);
  if (!isDone) notify('failed', node.name.slice(0, -NOTE_EXTENSION.length));
  await queueSync();
  return isDone;
}

/** Переименовать папку заметок. Заметки остаются в ней; ссылки на них идут по названиям заметок. */
export async function renameNoteFolder(
  folderId: string, name: string,
): Promise<FolderSubmitError | undefined> {
  const rootId = rootIdOf();
  const nodes = getNodes(rootId);
  const node = nodes.find(({ id }) => id === folderId);
  const clean = name.trim();
  if (!rootId || !node || !getNoteFolders().some(({ id }) => id === folderId)) return 'failed';
  if (clean === node.name) return undefined;
  const siblings = nodes.filter((other) => (
    other.kind === 'folder' && !other.trashed && other.id !== folderId && other.parent === node.parent
  )).map((other) => other.name);
  const error = checkFolderName(clean, siblings);
  if (error) return error;
  if (!(await renameCloudNode(rootId, node, clean))) return 'failed';
  await queueSync();
  return undefined;
}

/** Удалить папку заметок: пустая уходит в корзину облака. С заметками — только с `shouldMoveNotes`: заметки
 * сначала переносятся в «Без папки». Папка с файлами, которые не заметки, не удаляется — это делают в «Файлах». */
export async function deleteNoteFolder(folderId: string, shouldMoveNotes?: boolean): Promise<FolderDeleteResult> {
  const rootId = rootIdOf();
  const nodes = getNodes(rootId);
  const node = nodes.find(({ id }) => id === folderId);
  const vault = findVault(nodes);
  if (!rootId || !node || !vault || !getNoteFolders().some(({ id }) => id === folderId)) return 'failed';
  const inside = folderContents(nodes, folderId);
  if (inside.others.length) {
    notify('folder-files', node.name);
    return 'has-files';
  }
  if (inside.notes.length) {
    if (!shouldMoveNotes) return 'has-notes';
    if (!(await moveCloudNodes(rootId, inside.notes, vault.id))) {
      notify('failed', node.name);
      return 'failed';
    }
  }
  const isDone = await trashCloudNodes(rootId, [node]);
  await queueSync();
  return isDone ? 'done' : 'failed';
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

/** Переименовать холст; занятое название получает номер. Пустое название — отказ. */
export async function renameCanvas(canvasId: string, title: string) {
  const rootId = rootIdOf();
  const node = getNodes(rootId).find(({ id }) => id === canvasId);
  const canvas = getCanvases().find(({ id }) => id === canvasId);
  const clean = cleanTitle(title);
  if (!rootId || !node || !canvas || !clean) return false;
  if (clean === canvas.title) return true;
  const next = freeCanvasTitle(clean, getCanvases().filter(({ id }) => id !== canvasId).map((item) => item.title));
  if (!(await renameCloudNode(rootId, node, `${next}${CANVAS_EXTENSION}`))) return false;
  await queueSync();
  return true;
}

/** Холст — в корзину облака (оттуда его можно вернуть 30 дней). */
export async function deleteCanvas(canvasId: string) {
  const rootId = rootIdOf();
  const node = getNodes(rootId).find(({ id }) => id === canvasId);
  if (!rootId || !node) return false;
  const isDone = await trashCloudNodes(rootId, [node]);
  await queueSync();
  return isDone;
}
