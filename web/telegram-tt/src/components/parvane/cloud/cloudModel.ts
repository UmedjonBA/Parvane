import type { CloudNodeJson } from '../../../api/parvane/cloudDrive';

// Parvane (spec 016): чистая логика раздела «Облако» — дерево контейнера, как
// его отдаёт движок (узлы уже сведены, имена соседей различны), и то, что над
// ним считает экран: содержимое папки, путь, сортировка, поиск, корзина,
// свободное имя, занятое место, вид файла.

export type CloudNode = CloudNodeJson;
export type CloudSortKey = 'name' | 'date' | 'size';
export type CloudSort = { key: CloudSortKey; isDescending: boolean };
export type CloudFileKind = 'photo' | 'video' | 'audio' | 'pdf' | 'text' | 'other';
export type CloudNameError = 'empty' | 'too-long' | 'bad-chars' | 'reserved';

export const CLOUD_NAME_MAX_BYTES = 255;
export const CLOUD_MAX_NODES = 8000;
// Срок корзины: старше — стирает устройство владельца при синхронизации
export const CLOUD_TRASH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// Текстовый файл крупнее в просмотре не открывается (его можно скачать)
export const CLOUD_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const SERVICE_PREFIX = '.parvane-';
const TYPE_LABEL_MAX_LENGTH = 8;
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHARS = /[/\\\u0000-\u001f\u007f]/;
const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'oga', 'opus', 'm4a', 'wav', 'flac', 'aac']);
// Файлы, которые читаются как текст: заметки и холсты, данные, настройки, исходный код
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'canvas', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'svg', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx',
  'ts', 'tsx', 'py', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'swift', 'sh',
  'bash', 'zsh', 'fish', 'bat', 'ps1', 'sql', 'lua', 'pl', 'r', 'tex', 'srt', 'vtt', 'gcode', 'diff', 'patch', 'lock',
  'gradle', 'cmake', 'proto', 'graphql', 'vue', 'svelte', 'dart',
]);
const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-javascript',
  'application/typescript', 'application/x-sh', 'application/x-yaml', 'application/yaml', 'application/toml',
  'application/sql', 'application/x-ndjson', 'image/svg+xml',
]);

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

/** Служебный файл Parvane (отметка справки в хранилище заметок и подобные): имя начинается с `.parvane-`.
 * В списках, поиске и счётчиках «Файлов» не показывается; в корзине, квоте и занятых именах он обычный узел. */
export function isServiceNode(node: Pick<CloudNode, 'kind' | 'name'>) {
  return node.kind === 'file' && node.name.toLowerCase().startsWith(SERVICE_PREFIX);
}

/** Узлы для показа: без служебных файлов. */
export function listedNodes(nodes: CloudNode[]) {
  return nodes.some(isServiceNode) ? nodes.filter((node) => !isServiceNode(node)) : nodes;
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

// Сравнение имён с числами по значению («Фото 2» раньше «Фото 10»); один сравниватель на модуль —
// `localeCompare` с параметрами создавал бы его на каждое сравнение
const nameCollator = new Intl.Collator(undefined, { numeric: true });

/** Папки выше файлов; дальше — по выбранному полю, при равенстве — по имени. */
export function sortNodes(nodes: CloudNode[], sort: CloudSort) {
  const direction = sort.isDescending ? -1 : 1;
  const compareName = (a: CloudNode, b: CloudNode) => nameCollator.compare(a.name, b.name);
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

/** Положенное в корзину и пролежавшее там дольше срока (потомки стираются вместе с папкой). */
export function expiredTrashOf(nodes: CloudNode[], now: number, lifetimeMs = CLOUD_TRASH_LIFETIME_MS) {
  return nodes.filter((n) => n.trashTop && n.trashedAt > 0 && now - n.trashedAt >= lifetimeMs);
}

/** Сколько полных или начатых дней узлу осталось лежать в корзине (0 — срок вышел);
 * не больше срока, даже если часы положившего в корзину спешат. */
export function trashDaysLeft(node: CloudNode, now: number, lifetimeMs = CLOUD_TRASH_LIFETIME_MS) {
  const whole = Math.ceil(lifetimeMs / DAY_MS);
  if (!node.trashedAt) return whole;
  return Math.min(whole, Math.max(0, Math.ceil((node.trashedAt + lifetimeMs - now) / DAY_MS)));
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

export type FolderStats = { count: number; size: number };

/** Счётчики всех папок одним проходом: `count` — показываемые дети (как `childrenOf(listedNodes())`),
 * `size` — всё поддерево, с корзиной и служебными файлами (как `sizeOf`). Папки без детей в ответе нет. */
export function folderStats(nodes: CloudNode[]): Map<string, FolderStats> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stats = new Map<string, FolderStats>();
  const statsOf = (id: string) => {
    let known = stats.get(id);
    if (!known) {
      known = { count: 0, size: 0 };
      stats.set(id, known);
    }
    return known;
  };
  const hasService = nodes.some(isServiceNode);
  nodes.forEach((n) => {
    if (!n.parent) return;
    if (!n.trashed && !(hasService && isServiceNode(n))) statsOf(n.parent).count += 1;
    if (!n.size) return;
    let ancestor = byId.get(n.parent);
    for (let guard = 0; ancestor && guard <= nodes.length; guard++) {
      statsOf(ancestor.id).size += n.size;
      ancestor = ancestor.parent ? byId.get(ancestor.parent) : undefined;
    }
  });
  return stats;
}

export function kindOfFile(mime: string, name: string): CloudFileKind {
  const extension = getExtension(name);
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml' ? true : PHOTO_EXTENSIONS.has(extension)) return 'photo';
  // Расширение текста важнее типа: `.ts` браузер считает видео (MPEG-TS), `.svg` показываем исходником
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime.split(';')[0].trim())) return 'text';
  return 'other';
}

/** Подпись типа файла для заглушки просмотра: расширение прописными («3MF»); нет короткого — пусто. */
export function fileTypeLabel(name: string) {
  const extension = getExtension(name);
  return extension.length <= TYPE_LABEL_MAX_LENGTH && /^[\p{L}\p{N}_+-]+$/u.test(extension)
    ? extension.toUpperCase() : '';
}

/** Текст файла для просмотра: UTF-8 (в том числе с меткой порядка байтов), UTF-16 с меткой, иначе —
 * windows-1251 (старые русские файлы). Двоичное содержимое (нулевые байты) — `undefined`. */
export function decodeTextPreview(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes);
  }
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}
