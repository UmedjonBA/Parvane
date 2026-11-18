// Список заметок по макету (доски `Notes`, `PhNotesMore`, `DeskNotes`): порядок «недавние сверху», число связей
// заметки, первый тег и время правки для строки списка. Чистые функции — показ делает `NotesList`.

import type { LangFn } from '../../../util/localization';
import type { NotesIndex, NoteSource } from './notesModel';

import { parseNoteCached } from './notesModel';

const DAY_MS = 86400000;
// Правка не старше стольких дней показывается днём недели, старше — датой
const WEEKDAY_DAYS = 6;

// Время — всегда «13:10», как в макете: без «AM/PM» в языках с двенадцатичасовым счётом
const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

const formats = new Map<string, Intl.DateTimeFormat>();

function formatWith(locale: string, kind: string, options: Intl.DateTimeFormatOptions, date: Date) {
  const key = `${locale}:${kind}`;
  let format = formats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, options);
    } catch (err) {
      format = new Intl.DateTimeFormat(undefined, options);
    }
    formats.set(key, format);
  }
  return format.format(date).replace(/\.$/, '');
}

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Сколько календарных дней назад была правка: 0 — сегодня, 1 — вчера. */
export function countDaysAgo(updatedAt: number, now: number) {
  return Math.round((startOfDay(now) - startOfDay(updatedAt)) / DAY_MS);
}

/** Время правки в строке списка: сегодня — «13:10», вчера — словом, на этой неделе — «пн», раньше — «9 ноя». */
export function formatNoteTime(lang: LangFn, updatedAt: number, now: number) {
  const date = new Date(updatedAt);
  const daysAgo = countDaysAgo(updatedAt, now);
  if (daysAgo <= 0) return formatWith(lang.code, 'time', TIME_FORMAT, date);
  if (daysAgo === 1) return lang('WeekdayYesterday').toLowerCase();
  if (daysAgo <= WEEKDAY_DAYS) return formatWith(lang.code, 'weekday', { weekday: 'short' }, date);
  const isSameYear = date.getFullYear() === new Date(now).getFullYear();
  return isSameYear
    ? formatWith(lang.code, 'day', { day: 'numeric', month: 'short' }, date)
    : formatWith(lang.code, 'dayYear', { day: 'numeric', month: 'short', year: 'numeric' }, date);
}

/** Время правки под названием открытой заметки: «сегодня, 13:10», «вчера, 09:05», «9 ноя, 18:40». */
export function formatNoteEdited(lang: LangFn, updatedAt: number, now: number) {
  const date = new Date(updatedAt);
  const daysAgo = countDaysAgo(updatedAt, now);
  const time = formatWith(lang.code, 'time', TIME_FORMAT, date);
  if (daysAgo <= 0) return `${lang('Today')}, ${time}`;
  if (daysAgo === 1) return `${lang('WeekdayYesterday').toLowerCase()}, ${time}`;
  return `${formatNoteTime(lang, updatedAt, now)}, ${time}`;
}

/** Заметки от недавно правленых к давним; при равном времени — по названию. Исходный список не меняется. */
export function sortByRecent<T extends Pick<NoteSource, 'updatedAt' | 'title'>>(notes: T[]) {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt || (a.title < b.title ? -1 : 1));
}

/** Число связей заметки: на кого ссылается она (в том числе на ещё не созданные) и кто ссылается на неё. */
export function countNoteLinks(index: NotesIndex, noteId: string) {
  const indexed = index.byId(noteId);
  if (!indexed) return 0;
  const linked = new Set(indexed.linkedIds);
  index.backlinks(noteId).forEach(({ id }) => linked.add(id));
  return linked.size + indexed.unresolved.length;
}

/** Первый тег заметки для строки списка. */
export function firstTagOf(note: Pick<NoteSource, 'text'>) {
  return parseNoteCached(note).tags[0];
}
