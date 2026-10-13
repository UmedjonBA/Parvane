// Папки заметок «Знаний»: папки облака внутри хранилища. Чистые функции над деревом облака и списком
// заметок — перечень папок, проверка названия, содержимое папки, группы списка заметок.

import type { CloudNode } from '../cloud/cloudModel';

import { validateName } from '../cloud/cloudModel';

export type FolderNode = Pick<CloudNode, 'id' | 'kind' | 'name' | 'trashed'> & { parent?: string };
// `path` — названия папок от хранилища через «/»: то же значение, что `folder` у заметки
export type NoteFolder = { id: string; path: string; name: string };
export type FolderNameError = 'bad-name' | 'taken';
export type FolderSubmitError = FolderNameError | 'failed';
export type GroupedNote = { title: string; folder: string; isDaily: boolean };
export type NoteGroup<T extends GroupedNote> = {
  key: string;
  folder: string;
  // Узел папки; у «Без папки» и у папки, которой в дереве уже нет, его нет
  folderId?: string;
  isDaily: boolean;
  items: T[];
  // Сколько заметок дня не показано
  hidden: number;
};

export const ROOT_FOLDER = '';
export const DAILY_GROUP_KEY = '\u0000daily';
export const FOLDER_NAME_MAX = 80;
// Строки интерфейса для причин отказа
export const FOLDER_ERROR_KEYS = {
  'bad-name': 'KnowledgeFolderBadName',
  taken: 'KnowledgeFolderTaken',
  failed: 'KnowledgeFolderFailed',
} as const;

const PATH_SEPARATOR = '/';
const NOTE_EXTENSION = '.md';
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Папки хранилища, вложенные тоже; папки в корзине не считаются. По пути, по алфавиту. */
export function listNoteFolders(nodes: FolderNode[], vaultId: string): NoteFolder[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: NoteFolder[] = [];
  nodes.forEach((node) => {
    if (node.kind !== 'folder' || node.trashed || node.id === vaultId) return;
    const names = [node.name];
    let parent = node.parent ? byId.get(node.parent) : undefined;
    for (let depth = 0; parent && parent.id !== vaultId && depth <= nodes.length; depth++) {
      names.unshift(parent.name);
      parent = parent.parent ? byId.get(parent.parent) : undefined;
    }
    // Папка вне хранилища к заметкам не относится
    if (parent) result.push({ id: node.id, path: names.join(PATH_SEPARATOR), name: node.name });
  });
  return result.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Подпись папки в списке: вложенная — «А / Б». */
export function folderCaption(path: string) {
  return path.split(PATH_SEPARATOR).join(' / ');
}

/** Заметка лежит в папке либо глубже. */
export function isInFolder(noteFolder: string, path: string) {
  return noteFolder === path || noteFolder.startsWith(`${path}${PATH_SEPARATOR}`);
}

/** Годится ли название для папки рядом с `siblings` (регистр не различается). */
export function checkFolderName(name: string, siblings: string[]): FolderNameError | undefined {
  if (name !== name.trim() || validateName(name)) return 'bad-name';
  const key = name.toLowerCase();
  return siblings.some((sibling) => sibling.toLowerCase() === key) ? 'taken' : undefined;
}

/** Живые файлы папки на любой глубине: заметки и всё остальное (холсты, загруженные файлы). */
export function folderContents<T extends FolderNode>(nodes: T[], folderId: string) {
  const inside = new Set([folderId]);
  // Дерево не упорядочено: проходы повторяются, пока находятся новые вложенные папки
  for (let hasMore = true; hasMore;) {
    hasMore = false;
    nodes.forEach((node) => {
      if (node.kind !== 'folder' || node.trashed || inside.has(node.id)) return;
      if (!node.parent || !inside.has(node.parent)) return;
      inside.add(node.id);
      hasMore = true;
    });
  }
  const files = nodes.filter((node) => node.kind === 'file' && !node.trashed && node.parent && inside.has(node.parent));
  return {
    notes: files.filter(({ name }) => name.endsWith(NOTE_EXTENSION)),
    others: files.filter(({ name }) => !name.endsWith(NOTE_EXTENSION)),
  };
}

/** Группы списка заметок: «Без папки», папки по алфавиту (пустые тоже), заметки дня — в конце, свежие сверху.
 * При поиске (`isSearch`) остаются только группы с найденным. */
export function buildNoteGroups<T extends GroupedNote>({
  notes, folders, dailyFolders, isSearch, dailyShown,
}: {
  notes: T[];
  folders: NoteFolder[];
  // Названия папки заметок дня: пустая, она отдельной строкой не показывается
  dailyFolders: string[];
  isSearch?: boolean;
  // Сколько заметок дня показать; не задано — все
  dailyShown?: number;
}): NoteGroup<T>[] {
  const byFolder = new Map<string, T[]>();
  const daily: T[] = [];
  notes.forEach((note) => {
    if (note.isDaily && DAY_KEY.test(note.title)) daily.push(note);
    else {
      const items = byFolder.get(note.folder);
      if (items) items.push(note);
      else byFolder.set(note.folder, [note]);
    }
  });
  if (!isSearch) {
    folders.forEach(({ path }) => {
      if (!byFolder.has(path) && !dailyFolders.includes(path)) byFolder.set(path, []);
    });
    // «Без папки» видна, пока есть папки: в неё переносят заметки и в ней создают новые
    if (folders.length && !byFolder.has(ROOT_FOLDER)) byFolder.set(ROOT_FOLDER, []);
  }
  const idOf = (path: string) => folders.find((folder) => folder.path === path)?.id;
  const result: NoteGroup<T>[] = [...byFolder.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([folder, items]) => ({
      key: folder, folder, folderId: idOf(folder), isDaily: false, items, hidden: 0,
    }));
  if (daily.length) {
    daily.sort((a, b) => (a.title < b.title ? 1 : -1));
    const shown = isSearch || dailyShown === undefined ? daily : daily.slice(0, dailyShown);
    result.push({
      key: DAILY_GROUP_KEY,
      folder: daily[0].folder,
      folderId: idOf(daily[0].folder),
      isDaily: true,
      items: shown,
      hidden: daily.length - shown.length,
    });
  }
  return result;
}
