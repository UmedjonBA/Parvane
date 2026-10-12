// Parvane, раздел «Знания»: карточки файлов и ссылок на холсте — путь файла личного диска и обратно,
// сведения превью страницы. Чистые функции: в файл `.canvas` попадает только путь либо адрес.

import type { CloudNode } from '../cloud/cloudModel';

export type LinkPreviewSource = {
  url?: string; siteName?: string; title?: string; description?: string; imageBase64?: string; imageMime?: string;
};
export type LinkPreview = {
  host: string; title?: string; description?: string; siteName?: string; imageBase64?: string; imageMime?: string;
};

const NOTE_SUFFIX = '.md';
const PATH_SEPARATOR = '/';
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 400;
// Картинку превью рисуем только растровую: SVG может нести сценарий
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];
const SIZE_STEP = 1024;

// Путь файла от корня личного диска: названия папок и файла через «/». Нет узла — пусто
export function drivePathOf(nodes: CloudNode[], id: string) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const names: string[] = [];
  let current = byId.get(id);
  while (current && names.length <= nodes.length) {
    names.unshift(current.name);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return names.join(PATH_SEPARATOR);
}

// Файл личного диска по пути карточки. Файлы и папки в корзине не считаются; путь без папок ищется
// в корне диска
export function resolveDrivePath(nodes: CloudNode[], path: string): CloudNode | undefined {
  const names = path.split(PATH_SEPARATOR).filter(Boolean);
  let parent: string | undefined;
  let found: CloudNode | undefined;
  for (let i = 0; i < names.length; i++) {
    const kind = i === names.length - 1 ? 'file' : 'folder';
    const name = names[i];
    const folder = parent;
    found = nodes.find((node) => (
      !node.trashed && node.name === name && (node.parent || undefined) === folder && node.kind === kind
    ));
    if (!found) return undefined;
    parent = found.id;
  }
  return found;
}

// Название заметки по пути карточки: последняя часть пути без `.md`. Не `.md` — `undefined`
export function noteTitleOfPath(path?: string) {
  const name = fileNameOfPath(path);
  return name.toLowerCase().endsWith(NOTE_SUFFIX) && name.length > NOTE_SUFFIX.length
    ? name.slice(0, -NOTE_SUFFIX.length) : undefined;
}

export function fileNameOfPath(path?: string) {
  return (path || '').split(PATH_SEPARATOR).pop() || '';
}

// Узел сайта для подписи карточки-ссылки (без `www.`); адрес не разобрать — он сам
export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch (err) {
    return url;
  }
}

// Сведения превью для показа: пустые строки убраны, длинные обрезаны, название, совпавшее с узлом сайта,
// не повторяется, картинка — только растровая. `source` нет — превью недоступно, остаётся узел сайта
export function buildLinkPreview(url: string, source?: LinkPreviewSource): LinkPreview {
  const host = hostOf(url);
  const title = cleanText(source?.title, TITLE_MAX);
  const siteName = cleanText(source?.siteName, TITLE_MAX);
  const imageMime = (source?.imageMime || '').toLowerCase();
  const hasImage = Boolean(source?.imageBase64) && IMAGE_MIMES.includes(imageMime);
  return {
    host,
    title: title && title.toLowerCase() !== host.toLowerCase() ? title : undefined,
    description: cleanText(source?.description, DESCRIPTION_MAX),
    siteName: siteName && siteName.toLowerCase() !== host.toLowerCase() ? siteName : undefined,
    imageBase64: hasImage ? source?.imageBase64 : undefined,
    imageMime: hasImage ? imageMime : undefined,
  };
}

// Есть ли в превью что-то кроме узла сайта
export function hasPreviewContent(preview: LinkPreview) {
  return Boolean(preview.title || preview.description || preview.imageBase64);
}

// Размер файла для карточки: «0 B», «1.5 KB», «12 MB»
export function formatCardSize(bytes: number) {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= SIZE_STEP && unit < SIZE_UNITS.length - 1) {
    value /= SIZE_STEP;
    unit++;
  }
  const text = value >= 10 || unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${SIZE_UNITS[unit]}`;
}

function cleanText(text: string | undefined, max: number) {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, max) : undefined;
}
