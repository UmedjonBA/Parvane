import type { CloudNodeJson } from '../../../api/parvane/cloudDrive';

// Parvane (spec 016): чистая логика раздела «Облако» — дерево контейнера, как
// его отдаёт движок (узлы уже сведены, имена соседей различны), и то, что над
// ним считает экран: содержимое папки, путь, сортировка, поиск, корзина,
// свободное имя, занятое место, вид файла.

export type CloudNode = CloudNodeJson;
export type CloudSortKey = 'name' | 'date' | 'size';
export type CloudSort = { key: CloudSortKey; isDescending: boolean };
export type CloudFileKind = 'photo' | 'video' | 'audio' | 'pdf' | 'other';
export type CloudNameError = 'empty' | 'too-long' | 'bad-chars' | 'reserved';

export const CLOUD_NAME_MAX_BYTES = 255;
export const CLOUD_MAX_NODES = 8000;
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHARS = /[/\\\u0000-\u001f\u007f]/;
const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'oga', 'opus', 'm4a', 'wav', 'flac', 'aac']);

function byteLength(text: string) {
  return new TextEncoder().encode(text).length;
}

export function getExtension(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot + 1 < name.length ? name.slice(dot + 1).toLowerCase() : '';
}

/** Проверка имени — та же, что в движке (`cloud::check_name`). */
export function validateName(name: string): CloudNameError | undefined {
  if (!name.trim()) return 'empty';
  if (byteLength(name) > CLOUD_NAME_MAX_BYTES) return 'too-long';
  if (BAD_NAME_CHARS.test(name)) return 'bad-chars';
  if (name === '.' || name === '..') return 'reserved';
  return undefined;
}

/** Свободное имя среди соседей: «отчёт.pdf» → «отчёт (2).pdf». */
export function freeName(taken: Iterable<string>, name: string) {
  const set = new Set(taken);
  if (!set.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot + 1 < name.length;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${extension}`;
    if (!set.has(candidate)) return candidate;
  }
}

/** Содержимое папки (`parent` не задан — корень); корзина — отдельно. */
export function childrenOf(nodes: CloudNode[], parent?: string) {
  return nodes.filter((n) => !n.trashed && (n.parent || undefined) === parent);
}

/** Имена, занятые в папке (для подбора свободного). */
export function namesIn(nodes: CloudNode[], parent?: string, exceptId?: string) {
  return childrenOf(nodes, parent).filter((n) => n.id !== exceptId).map((n) => n.name);
}

/** Путь от корня до узла включительно. */
export function pathOf(nodes: CloudNode[], id?: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: CloudNode[] = [];
  let current = id ? byId.get(id) : undefined;
  while (current && path.length <= nodes.length) {
    path.unshift(current);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return path;
}

/** Узел и все его потомки. */
export function subtreeOf(nodes: CloudNode[], id: string) {
  const byParent = new Map<string, CloudNode[]>();
  nodes.forEach((n) => {
    if (!n.parent) return;
    const list = byParent.get(n.parent) || [];
    list.push(n);
    byParent.set(n.parent, list);
  });
  const root = nodes.find((n) => n.id === id);
  const out: CloudNode[] = root ? [root] : [];
  for (let i = 0; i < out.length; i++) out.push(...(byParent.get(out[i].id) || []));
  return out;
}

/** Можно ли переместить узлы в папку: не в себя и не в свою вложенную. */
export function canMoveInto(nodes: CloudNode[], movedIds: string[], target?: string) {
  if (!target) return true;
  const targetNode = nodes.find((n) => n.id === target);
  if (!targetNode || targetNode.kind !== 'folder' || targetNode.trashed) return false;
  const targetPath = new Set(pathOf(nodes, target).map((n) => n.id));
  return !movedIds.some((id) => targetPath.has(id));
}

/** Папки выше файлов; дальше — по выбранному полю, при равенстве — по имени. */
export function sortNodes(nodes: CloudNode[], sort: CloudSort) {
  const direction = sort.isDescending ? -1 : 1;
  const compareName = (a: CloudNode, b: CloudNode) => a.name.localeCompare(b.name, undefined, { numeric: true });
  return nodes.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    let result = 0;
    if (sort.key === 'date') result = a.mtime - b.mtime;
    if (sort.key === 'size') result = a.size - b.size;
    return (result || compareName(a, b)) * direction;
  });
}

/** Поиск по части имени во всём контейнере, кроме корзины. */
export function searchNodes(nodes: CloudNode[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return nodes.filter((n) => !n.trashed && n.name.toLocaleLowerCase().includes(needle));
}

/** Корзина: то, что положили в неё явно (потомки идут вместе с папкой). */
export function trashOf(nodes: CloudNode[]) {
  return nodes.filter((n) => n.trashTop).sort((a, b) => b.trashedAt - a.trashedAt);
}

/** Размеры: всё содержимое и отдельно корзина (файлы, сами и внутри папок). */
export function usageOf(nodes: CloudNode[]) {
  let total = 0;
  let trash = 0;
  nodes.forEach((n) => {
    total += n.size;
    if (n.trashed) trash += n.size;
  });
  return { total, trash };
}

/** Размер папки со всем вложенным. */
export function sizeOf(nodes: CloudNode[], id: string) {
  return subtreeOf(nodes, id).reduce((sum, n) => sum + n.size, 0);
}

export function kindOfFile(mime: string, name: string): CloudFileKind {
  const extension = getExtension(name);
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml' ? true : PHOTO_EXTENSIONS.has(extension)) return 'photo';
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return 'other';
}
