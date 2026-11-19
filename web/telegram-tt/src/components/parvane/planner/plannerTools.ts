import type { PlannerEvent, PlannerState, PlannerTask } from './plannerModel';

import { engineStatic } from '../../../api/parvane/v2/engine';
import {
  addDays, getDayIndex, instanceKey, isInstanceDone, toMinutes,
} from './plannerModel';

// Parvane, «План» (spec 041 E1, правило PLANNER-2): подбор свободного времени, разбор расписания текстом, поиск и
// тренировки для «Здоровья» считает движок (`plannerFreeTime`, `plannerScheduleParse`, `plannerSearch`,
// `plannerWorkouts`). Здесь — только сборка входа из состояния «Плана» (повторы раскрывает модель клиента) и
// вызов. Образец — `conformance/planner-tools/cases.json`.

export type FreeTimePart = 'any' | 'morning' | 'evening' | 'weekend';

export type FreeSlot = {
  day: string;
  weekday: number;
  start: number;
  end: number;
  // После окна до конца дня свободно
  isFreeAfter: boolean;
  // Окно кончается до первых дел дня
  isBeforeFirst: boolean;
  load: number;
  budget: number;
};

export type FreeTimeResult = { slots: FreeSlot[]; total: number };

export type ScheduleItem = {
  weekday: number;
  start: string;
  end: string;
  name: string;
  description?: string;
  // Конца в тексте не было — подставлен час
  isEndGuessed: boolean;
};

export type ScheduleProblem = { text: string; weekday?: number };

export type ParsedSchedule = { items: ScheduleItem[]; problems: ScheduleProblem[]; until?: string };

export type PlannerSearchFilter = 'all' | 'events' | 'tasks' | 'done';

export type PlannerSearchItem = {
  key: string;
  kind: 'event' | 'task';
  series?: string;
  name: string;
  description?: string;
  group?: string;
  day?: string;
  due?: string;
  start?: number;
  end?: number;
  isDone?: boolean;
  // Не уходит в движок: запись для показа и открытия
  task?: PlannerTask;
  event?: PlannerEvent;
};

export type PlannerSearchResult = { ahead: string[]; past: string[]; aheadTotal: number; pastTotal: number };

export type PlannedWorkout = {
  key: string;
  name: string;
  day: string;
  weekday: number;
  start?: number;
  minutes?: number;
  tag: string;
};

// Сколько дней ищется свободное время и сколько прошедшего попадает в поиск
export const FREE_TIME_DAYS = 7;
const SEARCH_PAST_DAYS = 90;
const SEARCH_AHEAD_DAYS = 366;
const WORKOUT_DAYS = 7;

/** Окна под запись длительностью `minutes` в `days` днях с `fromDay`; `exceptKey` — сама запись (не занятость). */
export function findFreeTime({
  state, minutes, fromDay, days = FREE_TIME_DAYS, part, limit, today, nowMinute, exceptKey,
}: {
  state: PlannerState;
  minutes: number;
  fromDay: string;
  days?: number;
  part: FreeTimePart;
  limit: number;
  today: string;
  nowMinute: number;
  exceptKey?: string;
}): FreeTimeResult {
  const toDay = addDays(fromDay, days - 1);
  const index = getDayIndex(state, fromDay, toDay);
  const dayList = Array.from({ length: days }, (_, offset) => {
    const day = addDays(fromDay, offset);
    const entry = index.get(day);
    const own = entry?.tasks.find((task) => instanceKey(task) === exceptKey);
    const busy = (entry?.timed || [])
      .filter((item) => (item.task ? instanceKey(item.task) : item.event && instanceKey(item.event)) !== exceptKey)
      .map((item) => [toMinutes(item.start), toMinutes(item.end)]);
    return { day, busy, load: (entry?.minutes || 0) - (own?.minutes || 0) };
  });
  return engineStatic<FreeTimeResult>('plannerFreeTime', {
    minutes,
    days: dayList,
    dayStart: state.settings.dayStart,
    dayEnd: state.settings.dayEnd,
    budget: state.budget,
    margin: state.settings.margin,
    part,
    limit,
    today,
    nowMinute,
  });
}

export function parseScheduleText(text: string, today: string) {
  const parsed = engineStatic<ParsedSchedule>('plannerScheduleParse', { text, today });
  // Движок пишет отсутствующее значение как `null`
  return {
    items: parsed.items.map((item) => ({ ...item, description: item.description || undefined })),
    problems: parsed.problems.map((problem) => ({ text: problem.text, weekday: problem.weekday ?? undefined })),
    until: parsed.until || undefined,
  };
}

/** Записи «Плана» для поиска: задачи без повтора целиком, ряды и события — экземплярами за 90 дней назад и год вперёд. */
export function buildSearchItems(state: PlannerState, today: string): PlannerSearchItem[] {
  const index = getDayIndex(state, addDays(today, -SEARCH_PAST_DAYS), addDays(today, SEARCH_AHEAD_DAYS));
  const items: PlannerSearchItem[] = [];
  state.tasks.forEach((task) => {
    if (task.repeat) return;
    const start = task.start ? toMinutes(task.start) : undefined;
    items.push({
      key: task.id,
      kind: 'task',
      name: task.name,
      description: task.description,
      group: task.project,
      day: task.day,
      due: task.due,
      start,
      end: start !== undefined && task.minutes !== undefined ? start + task.minutes : undefined,
      isDone: task.status === 'done',
      task,
    });
  });
  index.forEach((entry, day) => {
    entry.tasks.forEach((task) => {
      if (!task.repeat) return;
      const start = task.start ? toMinutes(task.start) : undefined;
      items.push({
        key: instanceKey(task),
        kind: 'task',
        series: task.id,
        name: task.name,
        description: task.description,
        group: task.project,
        day,
        start,
        end: start !== undefined && task.minutes !== undefined ? start + task.minutes : undefined,
        isDone: isInstanceDone(task, day),
        task,
      });
    });
    entry.events.forEach((event) => {
      items.push({
        key: instanceKey(event),
        kind: 'event',
        series: event.repeat ? event.id : undefined,
        name: event.name,
        description: event.description,
        group: event.project,
        day,
        start: event.isAllDay ? undefined : toMinutes(event.start),
        end: event.isAllDay ? undefined : toMinutes(event.end),
        event,
      });
    });
  });
  return items;
}

export function searchPlanner({
  items, query, filter, today, nowMinute, aheadLimit, pastLimit,
}: {
  items: PlannerSearchItem[];
  query: string;
  filter: PlannerSearchFilter;
  today: string;
  nowMinute: number;
  aheadLimit: number;
  pastLimit: number;
}) {
  return engineStatic<PlannerSearchResult>('plannerSearch', {
    query,
    filter,
    today,
    nowMinute,
    aheadLimit,
    pastLimit,
    items: items.map((item) => ({
      key: item.key,
      kind: item.kind,
      series: item.series,
      name: item.name,
      description: item.description,
      group: item.group,
      day: item.day,
      due: item.due,
      start: item.start ?? -1,
      end: item.end ?? -1,
      isDone: item.isDone,
    })),
  });
}

/** Тренировки «Плана» на неделю с `today` — для «Активности» «Здоровья». */
export function getPlannedWorkouts(state: PlannerState, today: string, nowMinute: number): PlannedWorkout[] {
  const index = getDayIndex(state, today, addDays(today, WORKOUT_DAYS - 1));
  const items: { key: string; name: string; day: string; start: number; minutes: number; isDone: boolean }[] = [];
  index.forEach((entry, day) => {
    entry.events.filter((event) => !event.isAllDay).forEach((event) => {
      items.push({
        key: instanceKey(event),
        name: event.name,
        day,
        start: toMinutes(event.start),
        minutes: toMinutes(event.end) - toMinutes(event.start),
        isDone: false,
      });
    });
    entry.tasks.forEach((task) => {
      items.push({
        key: instanceKey(task),
        name: task.name,
        day,
        start: task.start ? toMinutes(task.start) : -1,
        minutes: task.minutes || 0,
        isDone: task.repeat ? isInstanceDone(task, day) : task.status === 'done',
      });
    });
  });
  const result = engineStatic<PlannedWorkout[]>('plannerWorkouts', {
    items, today, nowMinute, days: WORKOUT_DAYS,
  });
  return result.map((item) => ({ ...item, start: item.start ?? undefined, minutes: item.minutes ?? undefined }));
}
