// Напоминания «Плана» (этап 4 плана 15 окт 2026): чистый расчёт моментов. Напоминание — у задачи или события с
// `remind` (минут до начала); начала нет (задача без времени, событие на весь день) — начало дня по настройкам.
// Ключ `<id>@<день>@<минут>` одинаков на всех устройствах: им помечается «уже напомнено» в данных «Плана».
import type { PlannerState } from './plannerModel';
import type { EngineState } from './plannerSync';

import {
  addDays, fromDayKey, getEventsForDay, getTasksForDay, isInstanceDone, toDayKey, toMinutes,
} from './plannerModel';
import { fromEngineState } from './plannerSync';

export type PlannerReminder = {
  key: string;
  // Момент напоминания, мс
  at: number;
  // Начало записи, мс
  startsAt: number;
  title: string;
  kind: 'task' | 'event';
  day: string;
  // Начало `HH:MM`; нет — запись без времени
  start?: string;
};

const MINUTE_MS = 60 * 1000;

export function reminderKey(id: string, day: string, minutes: number) {
  return `${id}@${day}@${minutes}`;
}

function momentOf(day: string, minutesOfDay: number) {
  const date = fromDayKey(day);
  date.setHours(0, minutesOfDay, 0, 0);
  return date.getTime();
}

/**
 * Напоминания с моментом в промежутке `[fromMs, toMs]`, по времени. Выполненные задачи не напоминают.
 * Напоминание «за неделю» может прийти на день раньше дня записи — поэтому дни перебираются с запасом.
 */
export function getReminders(state: PlannerState, fromMs: number, toMs: number): PlannerReminder[] {
  const dayStart = state.settings.dayStart;
  const out: PlannerReminder[] = [];
  const firstDay = toDayKey(new Date(fromMs));
  const lastDay = addDays(toDayKey(new Date(toMs)), 8);
  for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
    const add = (
      kind: PlannerReminder['kind'], id: string, title: string, minutes: number | undefined, start?: string,
    ) => {
      if (minutes === undefined) return;
      const startsAt = momentOf(day, start ? toMinutes(start) : dayStart);
      const at = startsAt - minutes * MINUTE_MS;
      if (at < fromMs || at > toMs) return;
      out.push({
        key: reminderKey(id, day, minutes), at, startsAt, title, kind, day, start,
      });
    };
    getTasksForDay(state, day).forEach((task) => {
      const isDone = task.repeat ? isInstanceDone(task, day) : task.status === 'done';
      if (!isDone) add('task', task.id, task.name, task.remind, task.start);
    });
    getEventsForDay(state, day).forEach((event) => {
      add('event', event.id, event.name, event.remind, event.isAllDay ? undefined : event.start);
    });
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/** Сработавшие и ещё не отмеченные: момент прошёл, но не раньше `sinceMs` (старые не догоняются). */
export function getDueReminders(state: PlannerState, nowMs: number, sinceMs: number) {
  const reminded = new Set(state.reminded);
  return getReminders(state, sinceMs, nowMs).filter(({ key }) => !reminded.has(key));
}

// Горизонт будильника: сервер принимает не дальше месяца
const HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
// Сколько сработавших без приложения дописывать в «Избранное» при открытии
const CATCH_UP_MS = 48 * 60 * 60 * 1000;
const MAX_UPCOMING = 64;

/** Для провайдера (кусок грузится лениво): из JSON движка — ближайшие и наступившие неотмеченные. */
export function readReminders(json: string, nowMs: number) {
  const state = fromEngineState(JSON.parse(json) as EngineState);
  return {
    upcoming: getReminders(state, nowMs, nowMs + HORIZON_MS).slice(0, MAX_UPCOMING),
    due: getDueReminders(state, nowMs, nowMs - CATCH_UP_MS),
  };
}
