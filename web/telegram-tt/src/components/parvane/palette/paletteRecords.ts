import type { PlannerSeriesItem, PlannerState, PlannerStep } from '../planner/plannerModel';
import type { PaletteItem } from './paletteSearch';

import { addDays, hasInstanceOn, REPEAT_HORIZON_DAYS } from '../planner/plannerModel';

// Parvane: записи «Плана» для палитры — события и задачи. Записи «Здоровья» в общий поиск не входят
export type PaletteRecordKind = 'task' | 'event';

export type PaletteRecordItem = PaletteItem & {
  group: 'record';
  kind: PaletteRecordKind;
  id: string;
  // День, на котором запись откроется; у задачи без даты его нет
  day?: string;
  // Начало `HH:MM` — вторая строка в палитре («Задача · вт, 14:00»)
  start?: string;
};

const MS_IN_DAY = 86400000;

function dayNumber(day: string) {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / MS_IN_DAY);
}

/** День записи: разовая дата либо ближайший от сегодня экземпляр ряда (нет впереди — начало ряда). */
export function recordDay(item: PlannerSeriesItem, today: string): string | undefined {
  if (!item.repeat) return item.day;
  for (let offset = 0; offset <= REPEAT_HORIZON_DAYS; offset++) {
    const day = addDays(today, offset);
    if (item.repeat.endDay && day > item.repeat.endDay) break;
    if (hasInstanceOn(item, day)) return day;
  }
  return item.repeat.startDay || undefined;
}

export function collectPlannerRecords(state: PlannerState, today: string): PaletteRecordItem[] {
  const events = state.events.map((event): PaletteRecordItem => ({
    key: `event:${event.id}`,
    group: 'record',
    module: 'plan',
    kind: 'event',
    id: event.id,
    title: event.name,
    text: joinRecordText(event.description, event.steps),
    day: recordDay(event, today),
    start: event.start || undefined,
  }));
  const tasks = state.tasks.map((task): PaletteRecordItem => ({
    key: `task:${task.id}`,
    group: 'record',
    module: 'plan',
    kind: 'task',
    id: task.id,
    title: task.name,
    text: joinRecordText(task.description, task.steps),
    day: recordDay(task, today),
    start: task.start,
  }));
  // Ближайшие к сегодня — первыми: при равном совпадении порядок источника решает, что видно
  const todayNumber = dayNumber(today);
  const distance = (item: PaletteRecordItem) => (
    item.day ? Math.abs(dayNumber(item.day) - todayNumber) : Number.POSITIVE_INFINITY
  );
  return [...events, ...tasks].sort((a, b) => {
    const da = distance(a);
    const db = distance(b);
    return da === db ? 0 : da - db;
  });
}

// Ищется описание и шаги записи — у задачи и у события
function joinRecordText(description: string | undefined, steps: PlannerStep[] | undefined) {
  return [description, ...(steps || []).map(({ text }) => text)].filter(Boolean).join('\n');
}
