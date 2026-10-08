/* eslint-disable no-null/no-null -- контракт JSON движка (planner_json.rs): null = «не задано», отсутствие поля = «без изменений» */
import type {
  PlannerFoodEntry, PlannerGoal, PlannerList, PlannerMacroGoals, PlannerNutrient, PlannerNutritionDay, PlannerState,
  PlannerTask,
} from './plannerModel';

import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, isKnownNumber, PLANNER_MEALS, PLANNER_STATUSES,
} from './plannerModel';

// Parvane (spec 010): планировщик ↔ движок. Состояние для экранов (`PlannerState`)
// строится из JSON движка (только живые объекты, без меток); правки уходят
// движку списком изменений: присутствующее поле — правка регистра, `null` у
// числа — «не задано», `deleted: true` — надгробие. Метки ставит движок.
// Формат JSON — `backend/protocol/src/domain/planner_json.rs`.

type EngineTask = {
  id: string;
  name: string;
  description: string;
  steps: { text: string; isDone: boolean }[];
  status: string;
  listId: string;
  rank: number;
  day: string;
  start: string;
  due: string;
  minutes: number | null;
};
type EngineEvent = { id: string; name: string; start: string; end: string; weekdays: number[] | null; day: string };
type EngineList = { id: string; name: string; order: number };
type EngineGoal = { target: number; tolerance: number } | null;
type EngineGoals = { kcal: EngineGoal; protein: EngineGoal; fat: EngineGoal; carbs: EngineGoal } | null;
type EngineEntry = {
  id: string;
  name: string;
  meal: string;
  kcal: number;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  fiber: number | null;
  grams: number | null;
  per100: boolean;
};
type EngineDay = {
  day: string; entries: EngineEntry[]; isComplete: boolean; fixedGoals: EngineGoals; waterMl: number | null;
};
type EngineSettings = {
  dayStart: number; dayEnd: number; lunchStart: number; lunchEnd: number; margin: number; budget: number;
} | null;
export type EngineState = {
  tasks: EngineTask[]; events: EngineEvent[]; lists: EngineList[]; nutrition: EngineDay[];
  settings: EngineSettings; goals: EngineGoals; headSeq: number; sizeBytes: number;
};

export type PlannerChange = Record<string, unknown>;

const NUTRIENTS: PlannerNutrient[] = ['kcal', 'protein', 'fat', 'carbs', 'fiber'];

// ── движок → состояние ───────────────────────────────────────────────────────

function goalFrom(goal: EngineGoal, fallback: PlannerGoal): PlannerGoal {
  return goal ? { target: goal.target, tolerance: goal.tolerance } : fallback;
}

function macroFrom(goals: EngineGoals, fallback: PlannerMacroGoals): PlannerMacroGoals {
  return {
    protein: goalFrom(goals?.protein ?? null, fallback.protein),
    fat: goalFrom(goals?.fat ?? null, fallback.fat),
    carbs: goalFrom(goals?.carbs ?? null, fallback.carbs),
  };
}

function entryFrom(e: EngineEntry): PlannerFoodEntry {
  const grams = e.grams ?? undefined;
  const per100: Partial<Record<PlannerNutrient, number>> | undefined = e.per100 && grams ? {} : undefined;
  const value = (v: number | null) => (v === null ? undefined : v);
  const entry: PlannerFoodEntry = {
    id: e.id,
    name: e.name,
    meal: PLANNER_MEALS.includes(e.meal as PlannerFoodEntry['meal']) ? e.meal as PlannerFoodEntry['meal'] : 'other',
    kcal: e.kcal,
    protein: value(e.protein),
    fat: value(e.fat),
    carbs: value(e.carbs),
    fiber: value(e.fiber),
    grams,
    per100,
  };
  if (per100 && grams) {
    NUTRIENTS.forEach((nutrient) => {
      const v = entry[nutrient];
      if (isKnownNumber(v)) per100[nutrient] = Math.round((v / grams) * 100 * 10000) / 10000;
    });
  }
  return entry;
}

/** JSON движка → состояние для экранов. */
export function fromEngineState(engine: EngineState): PlannerState {
  const empty = createEmptyPlannerState();
  const lists: PlannerList[] = [...engine.lists].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
  const nameById = new Map(lists.map((list) => [list.id, list.name]));
  const tasks: PlannerTask[] = engine.tasks.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    steps: t.steps.map((s) => ({ text: s.text, isDone: s.isDone })),
    status: PLANNER_STATUSES.includes(t.status as PlannerTask['status']) ? t.status as PlannerTask['status'] : 'queue',
    project: nameById.get(t.listId) || '',
    rank: t.rank,
    day: t.day || undefined,
    start: t.start || undefined,
    due: t.due || undefined,
    minutes: t.minutes === null ? undefined : t.minutes,
  }));
  const nutrition: Record<string, PlannerNutritionDay> = {};
  engine.nutrition.forEach((d) => {
    if (!d.entries.length && !d.isComplete && d.waterMl === null) return;
    nutrition[d.day] = {
      entries: d.entries.map(entryFrom),
      isComplete: d.isComplete,
      goal: d.fixedGoals?.kcal ? goalFrom(d.fixedGoals.kcal, empty.calorieGoal) : undefined,
      macroGoals: d.fixedGoals ? macroFrom(d.fixedGoals, empty.macroGoals) : undefined,
      waterMl: d.waterMl === null ? undefined : d.waterMl,
    };
  });
  const s = engine.settings;
  return {
    version: 1,
    tasks,
    events: engine.events.map((e) => ({
      id: e.id, name: e.name, start: e.start, end: e.end, weekdays: e.weekdays || undefined, day: e.day || undefined,
    })),
    projects: ['', ...lists.map((list) => list.name)],
    lists,
    nutrition,
    calorieGoal: goalFrom(engine.goals?.kcal ?? null, empty.calorieGoal),
    macroGoals: macroFrom(engine.goals, empty.macroGoals),
    budget: s?.budget ?? empty.budget,
    settings: s ? {
      dayStart: s.dayStart, dayEnd: s.dayEnd, lunchStart: s.lunchStart, lunchEnd: s.lunchEnd, margin: s.margin,
    } : { ...DEFAULT_PLANNER_SETTINGS },
  };
}

// ── состояние → изменения ───────────────────────────────────────────────────

function listIdOf(state: PlannerState, name: string) {
  return name ? state.lists.find((list) => list.name === name)?.id || '' : '';
}

function taskChange(state: PlannerState, t: PlannerTask): PlannerChange {
  return {
    task: {
      id: t.id,
      name: t.name,
      description: t.description,
      steps: t.steps.map((s) => ({ text: s.text, isDone: s.isDone })),
      status: t.status,
      listId: listIdOf(state, t.project),
      rank: t.rank,
      day: t.day || '',
      start: t.start || '',
      due: t.due || '',
      minutes: t.minutes === undefined ? null : t.minutes,
    },
  };
}

function eventChange(e: PlannerState['events'][number]): PlannerChange {
  return {
    event: { id: e.id, name: e.name, start: e.start, end: e.end, weekdays: e.weekdays || null, day: e.day || '' },
  };
}

function listChange(l: PlannerList): PlannerChange {
  return { list: { id: l.id, name: l.name, order: l.order } };
}

function goalsOf(calorie: PlannerGoal, macro: PlannerMacroGoals) {
  return { kcal: calorie, protein: macro.protein, fat: macro.fat, carbs: macro.carbs };
}

function entryOf(e: PlannerFoodEntry) {
  const num = (v: number | undefined) => (isKnownNumber(v) ? v : null);
  return {
    id: e.id,
    name: e.name,
    meal: e.meal,
    kcal: e.kcal,
    protein: num(e.protein),
    fat: num(e.fat),
    carbs: num(e.carbs),
    fiber: num(e.fiber),
    grams: num(e.grams),
    per100: Boolean(e.per100),
  };
}

function dayChange(day: string, d: PlannerNutritionDay, previous?: PlannerNutritionDay): PlannerChange {
  const entries: unknown[] = [];
  d.entries.forEach((e) => {
    const before = previous?.entries.find((p) => p.id === e.id);
    if (!before || JSON.stringify(before) !== JSON.stringify(e)) entries.push(entryOf(e));
  });
  previous?.entries.forEach((p) => {
    if (!d.entries.some((e) => e.id === p.id)) entries.push({ id: p.id, deleted: true });
  });
  const change: Record<string, unknown> = { day, entries };
  if (!previous || previous.isComplete !== d.isComplete) change.isComplete = d.isComplete;
  if (!previous || JSON.stringify(previous.goal) !== JSON.stringify(d.goal)
    || JSON.stringify(previous.macroGoals) !== JSON.stringify(d.macroGoals)) {
    change.fixedGoals = d.goal && d.macroGoals ? goalsOf(d.goal, d.macroGoals) : null;
  }
  if (!previous || previous.waterMl !== d.waterMl) change.waterMl = d.waterMl === undefined ? null : d.waterMl;
  return { nutritionDay: change };
}

function settingsChange(state: PlannerState): PlannerChange {
  return { settings: { ...state.settings, budget: state.budget } };
}

/** Разница состояний → изменения для движка (объект целиком — LWW по полям у движка). */
export function diffChanges(previous: PlannerState, next: PlannerState): PlannerChange[] {
  const changes: PlannerChange[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  next.lists.forEach((list) => {
    const before = previous.lists.find((l) => l.id === list.id);
    if (!before || !same(before, list)) changes.push(listChange(list));
  });
  previous.lists.forEach((list) => {
    if (!next.lists.some((l) => l.id === list.id)) changes.push({ list: { id: list.id, deleted: true } });
  });

  next.tasks.forEach((task) => {
    const before = previous.tasks.find((t) => t.id === task.id);
    if (!before || !same(before, task)) changes.push(taskChange(next, task));
  });
  previous.tasks.forEach((task) => {
    if (!next.tasks.some((t) => t.id === task.id)) changes.push({ task: { id: task.id, deleted: true } });
  });

  next.events.forEach((event) => {
    const before = previous.events.find((e) => e.id === event.id);
    if (!before || !same(before, event)) changes.push(eventChange(event));
  });
  previous.events.forEach((event) => {
    if (!next.events.some((e) => e.id === event.id)) changes.push({ event: { id: event.id, deleted: true } });
  });

  Object.entries(next.nutrition).forEach(([day, record]) => {
    const before = previous.nutrition[day];
    if (!before || !same(before, record)) changes.push(dayChange(day, record, before));
  });
  Object.entries(previous.nutrition).forEach(([day, record]) => {
    if (!next.nutrition[day]) {
      changes.push(dayChange(day, { entries: [], isComplete: false }, record));
    }
  });

  if (!same(previous.settings, next.settings) || previous.budget !== next.budget) changes.push(settingsChange(next));
  if (!same(previous.calorieGoal, next.calorieGoal) || !same(previous.macroGoals, next.macroGoals)) {
    changes.push({ goals: goalsOf(next.calorieGoal, next.macroGoals) });
  }
  return changes;
}

/** Данные этапа 1 (запись устройства) → изменения целиком; числовые id получают
 * префикс устройства, чтобы два устройства этапа 1 не дали коллизию (R7). */
export function legacyToChanges(legacy: PlannerState, devicePrefix: string): PlannerChange[] {
  const prefix = `legacy-${devicePrefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12)}-`;
  const rename = (id: string) => (/^\d+$/.test(id) ? `${prefix}${id}` : id);
  const state: PlannerState = {
    ...legacy,
    tasks: legacy.tasks.map((t) => ({ ...t, id: rename(t.id) })),
    events: legacy.events.map((e) => ({ ...e, id: rename(e.id) })),
  };
  const changes = diffChanges(createEmptyPlannerState(), state);
  // Настройки и цели по умолчанию diff не выдаёт — для переноса они не нужны
  changes.push({ migration: { sourceDevice: devicePrefix.slice(0, 64), count: changes.length } });
  return changes;
}

/** Запись устройства — ещё данные этапа 1 (не маркер переноса). */
export function isLegacyPlannerRecord(raw: unknown): raw is PlannerState {
  return Boolean(raw) && typeof raw === 'object' && (raw as { version?: unknown }).version === 1
    && Array.isArray((raw as { tasks?: unknown }).tasks);
}
