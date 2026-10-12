// Справка Parvane — папка связанных заметок о продукте в хранилище «Знаний». Создаётся один раз на аккаунт:
// в новом хранилище и в хранилище, где её ещё не было. «Была ли» хранит файл-отметка в корне хранилища
// (не заметка: в список и на граф не попадает) — он общий для устройств аккаунта и переживает удаление
// самой справки. Здесь только чистая логика: тексты, идентификаторы узлов и решение, что записать.

import type {
  GuideKey, GuideLang, GuideQuickSample, GuideSet,
} from './guide/types';

import { freeName } from '../cloud/cloudModel';
import { GUIDE_EN } from './guide/en';
import { GUIDE_RU } from './guide/ru';
import { normalizeNoteTitle } from './notesModel';

export type { GuideKey, GuideLang };

// Узел дерева облака — столько, сколько нужно решению
export type GuideNode = {
  id: string; kind: 'folder' | 'file'; parent?: string; name: string; trashed: boolean;
};
// Сверка личного диска с сервером (`parvaneCloudCheckDrive`): без неё судить «ещё нет» нельзя
export type GuideDrive = 'unknown' | 'none' | 'synced';
// `auto` — один раз на аккаунт, узлы с постоянными идентификаторами; `restore` — по кнопке, только недостающее
export type GuideMode = 'auto' | 'restore';
export type GuideSkipReason = 'drive-unknown' | 'has-marker' | 'vault-trashed' | 'complete';

export type GuideNote = { key: GuideKey; nodeId: string; title: string; text: string };
export type Guide = {
  lang: GuideLang;
  folderName: string;
  overviewTitle: string;
  notes: GuideNote[];
  datedSamples: string[];
  quickSamples: GuideQuickSample[];
};

export type GuideFolderWrite = { id: string; name: string; parent?: string };
// `nodeId` не задан — узел получает случайный идентификатор
export type GuideNoteWrite = { key: GuideKey; title: string; text: string; nodeId?: string };
export type GuidePlan = { action: 'skip'; reason: GuideSkipReason } | {
  action: 'write';
  // Хранилища ещё не было: оно создаётся вместе со справкой
  isFreshVault: boolean;
  vaultId: string;
  // Папка справки: существующая либо создаваемая этой же правкой
  folderId: string;
  // Папки одной правкой, от корня вглубь
  folders: GuideFolderWrite[];
  notes: GuideNoteWrite[];
  // Заметки справки, которых не будет: название занято заметкой пользователя либо узел уже существует
  skipped: GuideKey[];
  hasMarkerWrite: boolean;
};

export type GuidePlanInput = {
  drive: GuideDrive;
  nodes: GuideNode[];
  lang: GuideLang;
  // Название новой папки хранилища и все названия, под которыми она бывает
  vaultName: string;
  vaultNames: string[];
  mode: GuideMode;
  // Идентификатор новой папки, когда постоянный не годится
  makeId: () => string;
};

const NODE_ID_BYTES = 16;

export const GUIDE_VERSION = 1;
export const GUIDE_MARKER_NAME = '.parvane-guide.json';
export const GUIDE_MARKER_MIME = 'application/json';
// Постоянные идентификаторы: два устройства, создающие справку одновременно, дают одни и те же узлы, и движок
// сводит оба создания в одну папку и один набор заметок. Папка хранилища — тот же узел, что создавала прежняя
// «первая заметка»
export const VAULT_NODE_ID = '70617276616e652d6b6e6f776c656467';
export const GUIDE_FOLDER_NODE_ID = nodeIdOf('parvane-guide-fo');
export const GUIDE_MARKER_NODE_ID = nodeIdOf('parvane-guide-mk');

// Прежняя единственная заметка о разделе: её след значит, что хранилище у аккаунта уже заводили
const LEGACY_WELCOME_NODE_ID = '70617276616e652d77656c636f6d652d';
const NOTE_EXTENSION = '.md';
const SETS: Record<GuideLang, GuideSet> = { ru: GUIDE_RU, en: GUIDE_EN };
const GUIDE_LANGS: GuideLang[] = ['ru', 'en'];

/** Язык справки по коду языка интерфейса. */
export function getGuideLang(code?: string): GuideLang {
  return code?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function guideNoteNodeId(slot: number) {
  return nodeIdOf(`parvane-guide-${String(slot).padStart(2, '0')}`);
}

export function buildGuide(lang: GuideLang): Guide {
  const set = SETS[lang];
  const notes = set.notes.map(({
    key, slot, title, lines,
  }) => ({
    key, nodeId: guideNoteNodeId(slot), title, text: lines.join('\n'),
  }));
  return {
    lang,
    folderName: set.folderName,
    overviewTitle: notes.find(({ key }) => key === 'overview')!.title,
    notes,
    datedSamples: set.datedSamples,
    quickSamples: set.quickSamples,
  };
}

/** Содержимое файла-отметки. */
export function buildGuideMarker(lang: GuideLang, createdAt: number) {
  return `${JSON.stringify({ version: GUIDE_VERSION, createdAt, lang })}\n`;
}

/** Справку этому аккаунту уже создавали: отметка есть в хранилище, пусть и в корзине. */
export function hasGuideMarker(nodes: GuideNode[], vaultNames: string[]) {
  const vaultIds = new Set(nodes.filter((node) => isVaultFolder(node, vaultNames)).map(({ id }) => id));
  return nodes.some((node) => (
    node.id === GUIDE_MARKER_NODE_ID
    || (node.kind === 'file' && node.name === GUIDE_MARKER_NAME && Boolean(node.parent && vaultIds.has(node.parent)))
  ));
}

/** Заметка «Обзор» справки среди заметок: по постоянному узлу либо по названию на любом из языков. */
export function findGuideOverview<T extends { id: string; title: string }>(notes: T[]): T | undefined {
  const nodeId = guideNoteNodeId(SETS.ru.notes.find(({ key }) => key === 'overview')!.slot);
  const titles = GUIDE_LANGS.map((lang) => normalizeNoteTitle(buildGuide(lang).overviewTitle));
  return notes.find(({ id }) => id === nodeId)
    || notes.find(({ title }) => titles.includes(normalizeNoteTitle(title)));
}

/** Что записать, чтобы справка появилась, — либо причина ничего не делать. */
export function planGuide(input: GuidePlanInput): GuidePlan {
  const {
    drive, nodes, lang, vaultName, vaultNames, mode, makeId,
  } = input;
  if (drive === 'unknown') return { action: 'skip', reason: 'drive-unknown' };
  const isAuto = mode === 'auto';
  const hasMarker = hasGuideMarker(nodes, vaultNames);
  if (isAuto && hasMarker) return { action: 'skip', reason: 'has-marker' };

  const guide = buildGuide(lang);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const vault = nodes.find((node) => isVaultFolder(node, vaultNames) && !node.trashed);
  // Хранилище в корзине (либо остался след прежней первой заметки): его убрал сам пользователь
  const hasVaultTrace = nodes.some((node) => (
    isVaultFolder(node, vaultNames) || [VAULT_NODE_ID, LEGACY_WELCOME_NODE_ID, GUIDE_FOLDER_NODE_ID].includes(node.id)
  ));
  if (isAuto && !vault && hasVaultTrace) return { action: 'skip', reason: 'vault-trashed' };

  const folders: GuideFolderWrite[] = [];
  const vaultId = vault?.id || (isAuto ? VAULT_NODE_ID : makeId());
  if (!vault) folders.push({ id: vaultId, name: vaultName });
  const isInVault = (node: GuideNode) => isUnder(byId, node, vaultId);

  const fixedFolder = byId.get(GUIDE_FOLDER_NODE_ID);
  if (isAuto && fixedFolder?.trashed) {
    // Папку справки удалили раньше, чем легла отметка: остаётся только поставить её
    return {
      action: 'write',
      isFreshVault: false,
      vaultId,
      folderId: fixedFolder.id,
      folders: [],
      notes: [],
      skipped: [],
      hasMarkerWrite: true,
    };
  }
  const folderNames = GUIDE_LANGS.map((code) => SETS[code].folderName);
  const liveFolder = fixedFolder && !fixedFolder.trashed && (isAuto || isInVault(fixedFolder)) ? fixedFolder
    : isAuto ? undefined : nodes.find((node) => (
      node.kind === 'folder' && !node.trashed && node.parent === vaultId && folderNames.includes(node.name)
    ));
  const folderId = liveFolder?.id || (isAuto ? GUIDE_FOLDER_NODE_ID : makeId());
  if (!liveFolder) {
    const taken = nodes.filter((node) => !node.trashed && node.parent === vaultId).map(({ name }) => name);
    folders.push({ id: folderId, name: freeName(taken, guide.folderName), parent: vaultId });
  }

  // Названия живых заметок хранилища: заметку пользователя с тем же названием справка не трогает
  const takenTitles = new Map<string, string>();
  nodes.forEach((node) => {
    if (node.kind !== 'file' || node.trashed || !node.name.endsWith(NOTE_EXTENSION) || !isInVault(node)) return;
    takenTitles.set(normalizeNoteTitle(node.name.slice(0, -NOTE_EXTENSION.length)), node.id);
  });
  const notes: GuideNoteWrite[] = [];
  const skipped: GuideKey[] = [];
  guide.notes.forEach(({
    key, nodeId, title, text,
  }) => {
    // Узел с постоянным идентификатором уже создавали (он может лежать в корзине) — второй раз не создаётся
    const isKnown = isAuto && byId.has(nodeId);
    if (isKnown || takenTitles.has(normalizeNoteTitle(title))) {
      skipped.push(key);
      return;
    }
    notes.push({
      key, title, text, nodeId: isAuto ? nodeId : undefined,
    });
  });

  if (!isAuto && !notes.length && !folders.length && hasMarker) return { action: 'skip', reason: 'complete' };
  return {
    action: 'write',
    isFreshVault: !vault && isAuto,
    vaultId,
    folderId,
    folders,
    notes,
    skipped,
    hasMarkerWrite: !hasMarker,
  };
}

function isVaultFolder(node: GuideNode, vaultNames: string[]) {
  return node.kind === 'folder' && !node.parent && vaultNames.includes(node.name);
}

function isUnder(byId: Map<string, GuideNode>, node: GuideNode, ancestorId: string) {
  let parent = node.parent;
  for (let depth = 0; parent && depth <= byId.size; depth++) {
    if (parent === ancestorId) return true;
    parent = byId.get(parent)?.parent;
  }
  return false;
}

// Идентификатор узла из 16 знаков ASCII: читается в дереве и одинаков на всех устройствах
function nodeIdOf(tag: string) {
  if (tag.length !== NODE_ID_BYTES) throw new Error(`guide node tag must be ${NODE_ID_BYTES} chars: ${tag}`);
  return Array.from(tag, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
