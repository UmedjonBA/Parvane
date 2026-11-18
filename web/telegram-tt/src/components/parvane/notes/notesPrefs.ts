// Настройки модуля «Заметки» на этом устройстве: «справку уже показывали», папки графа,
// качество картинок на холсте

import type { CanvasImageQuality } from './notesCanvasImages';

const GUIDE_SEEN_KEY = 'parvane:knowledge-guide-seen';
const GRAPH_FOLDERS_KEY = 'parvane:knowledge-graph-folders';
const CANVAS_IMAGES_KEY = 'parvane:knowledge-canvas-images';
const GRAPH_FOLDERS_MAX = 200;

function read(key: string) {
  try {
    return localStorage.getItem(key) || undefined;
  } catch (err) {
    return undefined;
  }
}

function write(key: string, value?: string) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    // Хранилище недоступно (закрытый режим) — настройка живёт до перезагрузки
  }
}

/** Папки, выбранные на графе (пути, корень — пустая строка); `undefined` — все папки. */
export function readGraphFolders(): string[] | undefined {
  try {
    const value: unknown = JSON.parse(read(GRAPH_FOLDERS_KEY) || 'null');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
  } catch (err) {
    return undefined;
  }
}

export function writeGraphFolders(paths?: readonly string[]) {
  write(GRAPH_FOLDERS_KEY, paths && JSON.stringify(paths.slice(0, GRAPH_FOLDERS_MAX)));
}

/** Сообщение о появившейся справке на этом устройстве уже показано (либо справку открывали). */
export function isGuideSeen(userId?: string) {
  return read(`${GUIDE_SEEN_KEY}:${userId || ''}`) === '1';
}

export function markGuideSeen(userId?: string) {
  write(`${GUIDE_SEEN_KEY}:${userId || ''}`, '1');
}

/** Картинки карточек холста: сам файл (по умолчанию) либо миниатюра облака — экономия трафика на телефоне. */
export function readCanvasImageQuality(): CanvasImageQuality {
  return read(CANVAS_IMAGES_KEY) === 'thumb' ? 'thumb' : 'full';
}

export function writeCanvasImageQuality(quality: CanvasImageQuality) {
  write(CANVAS_IMAGES_KEY, quality);
}
