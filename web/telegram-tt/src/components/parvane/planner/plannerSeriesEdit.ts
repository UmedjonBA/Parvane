import type {
  PlannerEvent, PlannerRepeat, PlannerSeriesItem, PlannerState, PlannerTask,
} from './plannerModel';

import {
  addDays, detachInstance, hasInstanceOn, MAX_REPEAT_INTERVAL, occursOn,
} from './plannerModel';

// Чьё описание у повторяющейся записи: всех повторов или одного дня. Схема данных прежняя — «описание только
// этого дня» выражается отделённой копией дня (`origin`) и отметкой «день исключён» у ряда

export type PlannerSeriesKind = 'task' | 'event';

// Чьё описание: всех повторов ряда либо только этого дня
export type PlannerDescriptionScope = 'all' | 'one';

// Первый экземпляр еженедельного ряда может отстоять от начала на полный шаг недель
export const FIRST_DAY_HORIZON = MAX_REPEAT_INTERVAL * 7 + 7;

export function findSeriesItem(
  state: PlannerState, kind: PlannerSeriesKind, id: string,
): PlannerSeriesItem | undefined {
  return kind === 'task' ? state.tasks.find((t) => t.id === id) : state.events.find((e) => e.id === id);
}

function textOf(value: string | undefined) {
  return value || '';
}

// У задачи описание — строка (пустая — нет), у события — значение либо отсутствие
function writeDescription(kind: PlannerSeriesKind, item: PlannerSeriesItem, description: string) {
  item.description = kind === 'task' ? description : (description || undefined);
}

/** Первый день, в который правило даёт экземпляр; у ряда без даты начала отсчёт — от `fallbackDay`. */
export function firstSeriesDay(repeat: PlannerRepeat, fallbackDay: string) {
  const from = repeat.startDay || fallbackDay;
  if (!from) return undefined;
  for (let i = 0; i < FIRST_DAY_HORIZON; i++) {
    const day = addDays(from, i);
    if (repeat.endDay && day > repeat.endDay) return undefined;
    if (occursOn(repeat, day)) return day;
  }
  return undefined;
}

/**
 * Новая запись. У ряда с описанием «только этого дня» шаблон остаётся без описания, а первый день отделяется
 * копией с описанием («только это») — одной правкой состояния. Возвращает отделённую копию, если она появилась.
 */
export function addEntry(
  state: PlannerState,
  kind: PlannerSeriesKind,
  item: PlannerSeriesItem,
  scope: PlannerDescriptionScope,
  fallbackDay: string,
): PlannerSeriesItem | undefined {
  const description = textOf(item.description);
  const firstDay = item.repeat && scope === 'one' && description ? firstSeriesDay(item.repeat, fallbackDay) : undefined;
  const record = { ...item };
  // Первого дня нет (ряд пуст) — описание остаётся у ряда, а не теряется
  if (firstDay) writeDescription(kind, record, '');
  if (kind === 'task') state.tasks.push(record as PlannerTask);
  else state.events.push(record as PlannerEvent);
  if (!firstDay) return undefined;
  return detachInstance(state, kind, item.id, firstDay, { description });
}

/**
 * Что показывает галочка «Описание для всех повторов» у открытой записи: экземпляр ряда — «для всех»;
 * отделённый день — «для всех», пока его описание совпадает с описанием ряда. `undefined` — галочки нет
 * (разовая запись, шаблон ряда, отделённый день без ряда).
 */
export function getDescriptionScope(
  state: PlannerState, kind: PlannerSeriesKind, item: PlannerSeriesItem,
): PlannerDescriptionScope | undefined {
  if (item.repeat) return item.instanceDay ? 'all' : undefined;
  if (!item.origin) return undefined;
  const series = findSeriesItem(state, kind, item.origin.seriesId);
  if (!series?.repeat) return undefined;
  return textOf(series.description) === textOf(item.description) ? 'all' : 'one';
}

/**
 * Правка описания открытой записи. Экземпляр ряда: «для всех» — описание шаблона (уже отделённые дни хранят
 * своё), «только этот день» — день отделяется копией с описанием. Отделённый день: своё описание, а «для
 * всех» — ещё и описание ряда. Возвращает запись, которая теперь стоит в этом дне.
 */
export function setDescription(
  state: PlannerState,
  kind: PlannerSeriesKind,
  item: PlannerSeriesItem,
  description: string,
  scope: PlannerDescriptionScope,
): PlannerSeriesItem | undefined {
  if (item.repeat && item.instanceDay) {
    if (scope === 'one') return detachInstance(state, kind, item.id, item.instanceDay, { description });
    const series = findSeriesItem(state, kind, item.id);
    if (series) writeDescription(kind, series, description);
    return series;
  }
  const own = findSeriesItem(state, kind, item.id);
  if (!own) return undefined;
  writeDescription(kind, own, description);
  if (scope === 'all' && own.origin && !own.repeat) {
    const series = findSeriesItem(state, kind, own.origin.seriesId);
    if (series?.repeat) writeDescription(kind, series, description);
  }
  return own;
}

/** Описание отделённого дня становится описанием всего ряда; сам день остаётся отделённым. */
export function shareDescription(state: PlannerState, kind: PlannerSeriesKind, item: PlannerSeriesItem) {
  const series = item.origin && findSeriesItem(state, kind, item.origin.seriesId);
  if (!series?.repeat) return false;
  writeDescription(kind, series, textOf(item.description));
  return true;
}

/** Отделить день ряда копией со своим описанием — если ряд даёт в этот день экземпляр. */
export function detachWithDescription(
  state: PlannerState, kind: PlannerSeriesKind, id: string, day: string, description: string,
) {
  const series = findSeriesItem(state, kind, id);
  if (!series || !hasInstanceOn(series, day)) return undefined;
  return detachInstance(state, kind, id, day, { description });
}
