// Записи «Плана», связанные с заметками, — для списка (ближайшая дата), блока «Запланировано» и
// малого графа заметки. Связь — ссылка `[[Заметка]]` в названии записи либо задача, выросшая из пункта заметки.

import type { PlannerRepeat, PlannerState } from '../planner/plannerModel';

import { splitNameLinks } from '../planner/plannerLinks';
import { addDays, occursOn } from '../planner/plannerModel';
import { normalizeNoteTitle } from './notesModel';

export type PlannedItem = {
  key: string;
  kind: 'task' | 'event';
  // Название без разметки ссылок
  name: string;
  // День, по которому запись стоит в списке: дата, ближайший день ряда либо срок
  day?: string;
  time?: string;
  due?: string;
  repeat?: PlannerRepeat;
  isDone?: boolean;
  isActive?: boolean;
};

export type PlannedIndex = {
  byTitle: Map<string, PlannedItem[]>;
  byNote: Map<string, PlannedItem[]>;
};

const NOTE_SOURCE_PREFIX = 'note:';
// Ближайший день ряда ищется не дальше этого числа дней
const SERIES_LOOKAHEAD_DAYS = 120;
const NO_DAY = '9999';

function nextSeriesDay(repeat: PlannerRepeat, today: string) {
  for (let i = 0; i < SERIES_LOOKAHEAD_DAYS; i++) {
    const day = addDays(today, i);
    if (occursOn(repeat, day)) return day;
  }
  return repeat.startDay || undefined;
}

function plainName(name: string) {
  const text = splitNameLinks(name).filter((part) => !part.note).map((part) => part.text).join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text || splitNameLinks(name).map((part) => part.text).join('');
}

function linkedTitles(name: string) {
  return splitNameLinks(name).filter((part) => part.note).map((part) => normalizeNoteTitle(part.note!));
}

function sortKey(item: PlannedItem) {
  return `${item.day || NO_DAY}${item.time || ''}`;
}

/**
 * Заготовка строки ввода текстом для «Запланировать»: ссылка на заметку и пробел — дальше пользователь
 * дописывает, что и когда. Запись с такой ссылкой в названии встаёт в «Запланировано» заметки.
 */
export function notePlanLine(title: string) {
  return `[[${title.trim()}]] `;
}

/** Все записи «Плана» по заметкам: по названию из ссылки и по id заметки-источника. */
export function buildPlannedIndex(planner: PlannerState, today: string): PlannedIndex {
  const byTitle = new Map<string, PlannedItem[]>();
  const byNote = new Map<string, PlannedItem[]>();
  const put = (map: Map<string, PlannedItem[]>, key: string, item: PlannedItem) => {
    map.set(key, [...(map.get(key) || []), item]);
  };

  planner.tasks.forEach((task) => {
    const item: PlannedItem = {
      key: `t${task.id}`,
      kind: 'task',
      name: plainName(task.name),
      day: task.repeat ? nextSeriesDay(task.repeat, today) : task.day,
      time: task.start,
      due: task.due,
      repeat: task.repeat,
      isDone: task.status === 'done',
      isActive: task.status === 'active',
    };
    const source = task.source?.chat;
    if (source?.startsWith(NOTE_SOURCE_PREFIX)) put(byNote, source.slice(NOTE_SOURCE_PREFIX.length), item);
    new Set(linkedTitles(task.name)).forEach((title) => put(byTitle, title, item));
  });

  planner.events.forEach((event) => {
    const item: PlannedItem = {
      key: `e${event.id}`,
      kind: 'event',
      name: plainName(event.name),
      day: event.repeat ? nextSeriesDay(event.repeat, today) : event.day,
      time: event.isAllDay ? undefined : event.start,
      repeat: event.repeat,
    };
    new Set(linkedTitles(event.name)).forEach((title) => put(byTitle, title, item));
  });

  return { byTitle, byNote };
}

/** Записи одной заметки: сначала по дням, записи без дня — в конце. */
export function plannedOf(index: PlannedIndex, note: { id: string; title: string }): PlannedItem[] {
  const seen = new Set<string>();
  return [...(index.byNote.get(note.id) || []), ...(index.byTitle.get(normalizeNoteTitle(note.title)) || [])]
    .filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** Ближайшая запись с днём не раньше сегодняшнего. */
export function nearestPlanned(items: PlannedItem[], today: string) {
  return items.find((item) => item.day && item.day >= today && !item.isDone);
}
