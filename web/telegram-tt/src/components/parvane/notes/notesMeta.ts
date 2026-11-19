// «Заметки»: цвета папок и закреплённые заметки (доски `ZpNotesX`, `ZdNotesX`). Хранятся файлом
// `.parvane-notes.json` в корне хранилища — тем же зашифрованным облаком, что и заметки: доходят до всех устройств
// без нового метода сервера. Ключи — идентификаторы узлов: переименование и перенос их не сбивают. Правка — заплаткой
// поверх последней версии файла: два устройства, поменявшие разное, не затирают друг друга.

export const NOTES_META_NAME = '.parvane-notes.json';
export const NOTES_META_MIME = 'application/json';
export const FOLDER_TONES = ['blue', 'green', 'orange', 'purple', 'aqua', 'red'] as const;

export type FolderTone = typeof FOLDER_TONES[number];
export type NotesMeta = {
  // Цвет папки по id узла папки
  tones: Record<string, FolderTone>;
  // Закреплённые заметки по id узла, в порядке закрепления
  pinned: string[];
};
export type NotesMetaChange =
  { kind: 'tone'; folder: string; tone?: FolderTone }
  | { kind: 'pin'; note: string; isPinned: boolean };

const META_VERSION = 1;
const PINNED_MAX = 50;

export const EMPTY_NOTES_META: NotesMeta = { tones: {}, pinned: [] };

export function isFolderTone(value: unknown): value is FolderTone {
  return typeof value === 'string' && (FOLDER_TONES as readonly string[]).includes(value);
}

/** Разбор файла; повреждённый либо чужой файл читается как пустой. */
export function parseNotesMeta(text: string | undefined): NotesMeta {
  if (!text) return EMPTY_NOTES_META;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_NOTES_META;
  }
  if (!raw || typeof raw !== 'object') return EMPTY_NOTES_META;
  const { tones, pinned } = raw as { tones?: unknown; pinned?: unknown };
  const meta: NotesMeta = { tones: {}, pinned: [] };
  if (tones && typeof tones === 'object') {
    Object.entries(tones).forEach(([id, tone]) => {
      if (isFolderTone(tone)) meta.tones[id] = tone;
    });
  }
  if (Array.isArray(pinned)) {
    meta.pinned = [...new Set(pinned.filter((id): id is string => typeof id === 'string'))].slice(0, PINNED_MAX);
  }
  return meta;
}

export function serializeNotesMeta(meta: NotesMeta) {
  return `${JSON.stringify({ v: META_VERSION, tones: meta.tones, pinned: meta.pinned }, undefined, 2)}\n`;
}

export function applyNotesMetaChange(meta: NotesMeta, change: NotesMetaChange): NotesMeta {
  if (change.kind === 'tone') {
    const tones = { ...meta.tones };
    if (change.tone) tones[change.folder] = change.tone;
    else delete tones[change.folder];
    return { ...meta, tones };
  }
  const pinned = meta.pinned.filter((id) => id !== change.note);
  if (change.isPinned) pinned.unshift(change.note);
  return { ...meta, pinned: pinned.slice(0, PINNED_MAX) };
}

/** Закреплённые — вверху в порядке закрепления, остальные — в прежнем порядке. */
export function sortPinnedFirst<T extends { id: string }>(notes: T[], pinned: string[]) {
  if (!pinned.length) return notes;
  const rank = new Map(pinned.map((id, index) => [id, index]));
  const top = notes.filter(({ id }) => rank.has(id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return top.length ? [...top, ...notes.filter(({ id }) => !rank.has(id))] : notes;
}

/** Цвета верхних папок по пути: цвет папки — у неё самой; у вложенных — цвет верхней. */
export function tonesByTopPath(meta: NotesMeta, folders: { id: string; path: string }[]) {
  const result = new Map<string, FolderTone>();
  folders.forEach(({ id, path }) => {
    const tone = meta.tones[id];
    if (tone && !path.includes('/')) result.set(path, tone);
  });
  return result;
}
