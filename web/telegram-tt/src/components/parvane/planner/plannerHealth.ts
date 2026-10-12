// Здоровье в «Плане» (spec 020): применение черновика ввода текстом и сводки для экранов.
// Показатели вписывает пользователь; записи хранят только факт — источник автоматического сбора
// (мобильный клиент) сможет дописывать такие же записи с теми же идентификаторами дня.

import type {
  PlannerGoalMetric, PlannerHealthKind, PlannerHealthRecord, PlannerState,
} from './plannerModel';
import type { QuickDraft } from './plannerQuick';

import {
  addDays, ALL_DAY_END, ALL_DAY_START, isKnownNumber, makeFoodEntry, newId, toMinutes,
} from './plannerModel';

// Сна меньше этого — бюджет дня снижается
export const SHORT_SLEEP_MINUTES = 360;
export const SHORT_SLEEP_BUDGET_FACTOR = 0.8;
const WEEK_DAYS = 7;
// Допуск цели, заданной текстом: десятая часть значения
const GOAL_TOLERANCE_SHARE = 0.1;
const MINUTES_IN_HOUR = 60;

/** Идентификатор записи показателя, у которого одно значение на день. */
export function dailyRecordId(kind: PlannerHealthKind, day: string) {
  return `${kind}-${day}`;
}

function putDaily(state: PlannerState, record: PlannerHealthRecord) {
  state.health = [...state.health.filter(({ id }) => id !== record.id), record];
}

/** Записать черновик ввода текстом в состояние; возвращает подпись для уведомления либо `undefined`. */
export function applyQuickDraft(state: PlannerState, draft: QuickDraft, today: string): string | undefined {
  if (draft.error) return undefined;
  const day = draft.day || today;
  const repeat = draft.repeat;
  switch (draft.kind) {
    case 'event':
      state.events.push({
        id: newId(),
        name: draft.name,
        description: draft.description,
        start: draft.isAllDay ? ALL_DAY_START : draft.start!,
        end: draft.isAllDay ? ALL_DAY_END : draft.end!,
        day: repeat ? undefined : draft.day,
        repeat,
        isAllDay: draft.isAllDay,
      });
      return draft.name;
    case 'task':
      state.tasks.push({
        id: newId(),
        name: draft.name,
        description: draft.description || '',
        steps: [],
        status: 'queue',
        project: '',
        minutes: draft.minutes,
        day: repeat ? undefined : draft.day,
        start: draft.start,
        due: draft.due,
        repeat,
        // Новая задача — первой в очереди
        rank: Math.min(0, ...state.tasks.map(({ rank }) => rank)) - 1,
      });
      return draft.name;
    case 'food': {
      const nutrients = draft.nutrients || {};
      const entry = makeFoodEntry({
        name: draft.name,
        meal: draft.meal || 'other',
        isPer100: false,
        values: {
          kcal: nutrients.kcal,
          protein: nutrients.protein,
          fat: nutrients.fat,
          carbs: nutrients.carbs,
          fiber: nutrients.fiber,
        },
      });
      const record = state.nutrition[day] || { entries: [], isComplete: false };
      state.nutrition[day] = {
        ...record,
        entries: [...record.entries, {
          ...entry, grams: draft.grams, sugar: nutrients.sugar, salt: nutrients.salt, time: draft.start,
        }],
      };
      return draft.name;
    }
    case 'water': {
      const record = state.nutrition[day] || { entries: [], isComplete: false };
      state.nutrition[day] = { ...record, waterMl: (record.waterMl || 0) + draft.waterMl! };
      return String(draft.waterMl);
    }
    case 'sleep':
      // Сон дня один: новая запись заменяет прежнюю
      putDaily(state, {
        id: dailyRecordId('sleep', day),
        day,
        kind: 'sleep',
        time: draft.start,
        endTime: draft.end,
        value: draft.minutes!,
      });
      return 'sleep';
    case 'metric':
      putDaily(state, {
        id: dailyRecordId(draft.metric!, day), day, kind: draft.metric!, value: draft.value!, value2: draft.value2,
      });
      return draft.metric;
    case 'workout':
      state.health = [...state.health, {
        id: newId(),
        day,
        kind: 'workout',
        time: draft.start,
        value: draft.minutes || 0,
        value2: draft.distanceKm,
        name: draft.name,
        exercises: draft.exercises,
      }];
      return draft.name;
    case 'goal': {
      const changes = draft.goalChanges!;
      const goals = { ...state.goals };
      (Object.entries(changes.goals) as [PlannerGoalMetric, number][]).forEach(([metric, value]) => {
        const target = Math.max(1, Math.round(value));
        goals[metric] = {
          target,
          tolerance: Math.min(target, goals[metric]?.tolerance ?? Math.round(target * GOAL_TOLERANCE_SHARE)),
        };
      });
      state.goals = goals;
      state.healthGoals = { ...state.healthGoals, ...changes.health };
      if (changes.dayStart !== undefined) {
        state.settings = { ...state.settings, dayStart: changes.dayStart, dayEnd: changes.dayEnd! };
      }
      if (changes.budget) state.budget = Math.round(changes.budget / MINUTES_IN_HOUR) * MINUTES_IN_HOUR;
      return 'goal';
    }
    default:
      return undefined;
  }
}

/** Запись показателя дня (одна на день). */
export function getDailyRecord(state: PlannerState, kind: PlannerHealthKind, day: string) {
  return state.health.find((record) => record.kind === kind && record.day === day);
}

/** Последняя запись показателя не позже дня. */
export function getLatestRecord(state: PlannerState, kind: PlannerHealthKind, day: string) {
  return state.health
    .filter((record) => record.kind === kind && record.day <= day)
    .sort((a, b) => (a.day < b.day ? 1 : -1))[0];
}

/** Дни недели, заканчивающейся этим днём (от старого к новому). */
export function getLastDays(day: string, count = WEEK_DAYS) {
  return Array.from({ length: count }, (_, index) => addDays(day, index - count + 1));
}

/** Значения показателя по дням; `undefined` — записи нет. */
export function getDailySeries(state: PlannerState, kind: PlannerHealthKind, days: string[]) {
  return days.map((day) => getDailyRecord(state, kind, day)?.value);
}

export function getWorkouts(state: PlannerState, days: string[]) {
  return state.health
    .filter((record) => record.kind === 'workout' && days.includes(record.day))
    .sort((a, b) => (a.day === b.day ? (b.time || '').localeCompare(a.time || '') : a.day < b.day ? 1 : -1));
}

/** Активные минуты за дни: длительность тренировок. */
export function getActiveMinutes(state: PlannerState, days: string[]) {
  return getWorkouts(state, days).reduce((sum, record) => sum + record.value, 0);
}

/** Темп «мин:сек на километр». */
export function formatPace(minutes: number, km: number) {
  if (!minutes || !km) return undefined;
  const seconds = Math.round((minutes * MINUTES_IN_HOUR) / km);
  return `${Math.floor(seconds / MINUTES_IN_HOUR)}:${String(seconds % MINUTES_IN_HOUR).padStart(2, '0')}`;
}

/** Сумма сахара либо соли за день. */
export function getLimitTotal(state: PlannerState, day: string, nutrient: 'sugar' | 'salt') {
  return (state.nutrition[day]?.entries || [])
    .reduce((sum, entry) => sum + (isKnownNumber(entry[nutrient]) ? entry[nutrient] : 0), 0);
}

/** Сон короче порога снижает бюджет дня. */
export function isShortSleep(state: PlannerState, day: string) {
  const sleep = getDailyRecord(state, 'sleep', day);
  return sleep ? sleep.value < SHORT_SLEEP_MINUTES : false;
}

export function getDayBudget(state: PlannerState, day: string) {
  return isShortSleep(state, day) ? Math.round(state.budget * SHORT_SLEEP_BUDGET_FACTOR) : state.budget;
}

/** Время подъёма (минуты от полуночи) по записи сна дня. */
export function getWakeMinutes(state: PlannerState, day: string) {
  const end = getDailyRecord(state, 'sleep', day)?.endTime;
  return end ? toMinutes(end) : undefined;
}
