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
  // Свободные минуты после окна до следующего дела либо до конца окна дня
  spare: number;
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
  // Номер куска в тексте: непонятое встаёт на своё место среди понятого
  order: number;
};

// `rest` — кусок без дня недели
export type ScheduleProblem = { text: string; weekday?: number; order: number; rest: string };

export type ParsedSchedule = { items: ScheduleItem[]; problems: ScheduleProblem[]; until?: string };

export type PlannerSearchFilter = 'all' | 'events' | 'tasks' | 'done';
// «Что показывать» компьютера (доска `ZdPlanX`): несколько сразу
export type PlannerSearchShow = 'events' | 'tasks' | 'done' | 'offers';

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
  // Запись из задания, присланного в чат
  isFromChat?: boolean;
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
    problems: parsed.problems.map((problem) => ({
      text: problem.text, weekday: problem.weekday ?? undefined, order: problem.order, rest: problem.rest,
    })),
    until: parsed.until || undefined,
  };
}

// Задача либо событие из карточки задания в чате; задачи из пунктов заметок (`note:*`) — не из чата
function isFromChat(record: PlannerTask | PlannerEvent) {
  return Boolean(record.source && !record.source.chat.startsWith('note:'));
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
      isFromChat: isFromChat(task),
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
        isFromChat: isFromChat(task),
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
        isFromChat: isFromChat(event),
        event,
      });
    });
  });
  return items;
}

export function searchPlanner({
  items, query, filter, show, hiddenGroups, today, nowMinute, aheadLimit, pastLimit,
}: {
  items: PlannerSearchItem[];
  query: string;
  filter: PlannerSearchFilter;
  // Колонка «Слои / Что показывать» (компьютер): набор вместо `filter` и выключенные группы ('' — без группы)
  show?: PlannerSearchShow[];
  hiddenGroups?: string[];
  today: string;
  nowMinute: number;
  aheadLimit: number;
  pastLimit: number;
}) {
  return engineStatic<PlannerSearchResult>('plannerSearch', {
    query,
    filter,
    show,
    hiddenGroups: hiddenGroups || [],
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
      fromChat: item.isFromChat,
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

export type RecordActionKind = 'tomorrow' | 'place' | 'duplicate';

// `move` — правка самой записи, `detach` — отделение дня ряда, `copy` — новая запись `record`, `none` — нечего делать
export type RecordAction = {
  mode: 'move' | 'detach' | 'copy' | 'none';
  day?: string;
  start?: string;
  minutes?: number;
  due?: string;
  record?: Partial<PlannerTask & PlannerEvent>;
};

/** Что сделать с записью по действию меню либо перетаскиванию на шкалу (`plannerRecordAction`). */
export function getRecordAction({
  action, item, today, dropDay, dropMinute, step,
}: {
  action: RecordActionKind;
  item: PlannerTask | PlannerEvent;
  today: string;
  dropDay?: string;
  dropMinute?: number;
  // Шаг минуты на шкале (15 по умолчанию; окно свободного времени ставится точно — 1)
  step?: number;
}): RecordAction {
  const isTask = 'status' in item;
  const minutes = isTask ? item.minutes : toMinutes(item.end) - toMinutes(item.start);
  const result = engineStatic<RecordAction>('plannerRecordAction', {
    action,
    today,
    day: item.day,
    instanceDay: item.instanceDay,
    isSeries: Boolean(item.repeat),
    due: isTask ? item.due : undefined,
    minutes: minutes ?? -1,
    dropDay,
    dropMinute: dropMinute ?? -1,
    step,
    record: action === 'duplicate' ? item : undefined,
  });
  // Движок пишет отсутствующее значение как `null`
  return {
    mode: result.mode,
    day: result.day || undefined,
    start: result.start || undefined,
    minutes: result.minutes ?? undefined,
    due: result.due || undefined,
    record: result.record || undefined,
  };
}
