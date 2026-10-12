// Вид заметки в списках: цвет по папке, буква плитки, показ названия заметки дня, строка под названием

import type { LangFn } from '../../../util/localization';
import type { NoteEntry } from './notesStore';

import { fromDayKey } from '../planner/plannerModel';
import { parseNote } from './notesModel';

const FOLDER_TONES = ['blue', 'green', 'orange', 'purple', 'aqua', 'red'] as const;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_MAX = 140;
const HASH_BASE = 31;
const HASH_SEED = 7;

/** Цвет папки: один и тот же у папки на всех экранах; заметки дня и без папки — цвет заметок. */
export function folderColor(folder: string, isDaily?: boolean) {
  const top = folder.split('/')[0];
  if (isDaily || !top) return 'var(--pv-note)';
  let hash = HASH_SEED;
  for (const char of top) hash = (hash * HASH_BASE + char.codePointAt(0)!) % 0xffff;
  return `var(--pv-${FOLDER_TONES[hash % FOLDER_TONES.length]})`;
}

export function isDayTitle(title: string) {
  return DAY_KEY.test(title);
}

/** Название для показа: у заметки дня — «пн, 12 октября». */
export function displayTitle(lang: LangFn, note: Pick<NoteEntry, 'title' | 'isDaily'>) {
  if (!note.isDaily || !isDayTitle(note.title)) return note.title;
  return fromDayKey(note.title).toLocaleDateString(lang.code, { weekday: 'short', day: 'numeric', month: 'long' });
}

/** Знак на плитке списка: первая буква названия, у заметки дня — число. */
export function avatarText(note: Pick<NoteEntry, 'title' | 'isDaily'>) {
  if (note.isDaily && isDayTitle(note.title)) return String(fromDayKey(note.title).getDate());
  return (Array.from(note.title.trim())[0] || '').toUpperCase();
}

/** Короткая дата: «12 окт». */
export function formatDayShort(lang: LangFn, day: string) {
  return fromDayKey(day).toLocaleDateString(lang.code, { day: 'numeric', month: 'short' }).replace(/\.$/, '');
}

// Строка под названием в списке: первая содержательная строка текста, не повторяющая само название
export function previewOf(note: Pick<NoteEntry, 'title' | 'text'>) {
  const title = note.title.trim().toLowerCase();
  const line = parseNote(note.text).body.split('\n')
    .map((item) => item.replace(/^#+\s*|^\s*[-*+] (\[[ xX]\] )?/, '')
      .replace(/ \^t[a-z0-9]{4,12}\s*$/, '')
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')
      .replace(/`/g, '')
      .trim())
    .find((item) => item && item.toLowerCase() !== title);
  return (line || '').slice(0, PREVIEW_MAX);
}
