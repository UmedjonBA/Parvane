/* eslint-disable no-null/no-null -- контракт JSON движка (planner_json.rs): null = «не задано», отсутствие поля = «без изменений» */
import type {
  PlannerEvent, PlannerFoodEntry, PlannerGoal, PlannerGoalRecord, PlannerGoalValues, PlannerList, PlannerNutrient,
  PlannerNutritionDay, PlannerOccurrence, PlannerRepeat, PlannerState, PlannerTask,
} from './plannerModel';

import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, isKnownNumber, PLANNER_GOAL_METRICS, PLANNER_MEALS,
  PLANNER_REPEAT_KINDS, PLANNER_STATUSES,
} from './plannerModel';

// Parvane (spec 010): планировщик ↔ движок. Состояние для экранов (`PlannerState`)
// строится из JSON движка (только живые объекты, без меток); правки уходят
// движку списком изменений: присутствующее поле — правка регистра, `null` у
// числа — «не задано», `deleted: true` — надгробие. Метки ставит движок.
// Формат JSON — `backend/protocol/src/domain/planner_json.rs`.

// spec 011: правило повтора, состояние экземпляров, происхождение, задание-источник
type EngineRepeat = {
  kind: string; interval: number; weekdays: number[]; monthDay: number; startDay: string; endDay: string; count: number;
} | null;
type EngineOccurrence = { day: string; excluded: boolean; done: boolean; doneSteps: number[] };
type EngineOrigin = { seriesId: string; day: string } | null;
type EngineSource = { chat: string; opId: string } | null;
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
  repeat?: EngineRepeat;
  occurrences?: EngineOccurrence[];
  origin?: EngineOrigin;
  source?: EngineSource;
};
type EngineEvent = {
  id: string; name: string; start: string; end: string; weekdays: number[] | null; day: string;
  repeat?: EngineRepeat; occurrences?: EngineOccurrence[]; origin?: EngineOrigin;
};
type EngineList = { id: string; name: string; order: number };
type EngineGoal = { target: number; tolerance: number } | null;
type EngineGoals = {
  kcal: EngineGoal; protein: EngineGoal; fat: EngineGoal; carbs: EngineGoal; fiber?: EngineGoal; water?: EngineGoal;
} | null;
type EngineGoalPeriod = {
  id: string; startDay: string; endDay: string;
  kcal: EngineGoal; protein: EngineGoal; fat: EngineGoal; carbs: EngineGoal; fiber: EngineGoal; water: EngineGoal;
};
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
  settings: EngineSettings; goals: EngineGoals; goalPeriods?: EngineGoalPeriod[]; headSeq: number; sizeBytes: number;
};

export type PlannerChange = Record<string, unknown>;

const NUTRIENTS: PlannerNutrient[] = ['kcal', 'protein', 'fat', 'carbs', 'fiber'];

// ── движок → состояние ───────────────────────────────────────────────────────

function goalValuesFrom(goals: EngineGoals | EngineGoalPeriod | undefined): PlannerGoalValues {
  const out: PlannerGoalValues = {};
  if (!goals) return out;
  PLANNER_GOAL_METRICS.forEach((metric) => {
    const goal = (goals as Record<string, EngineGoal | undefined>)[metric];
    if (goal) out[metric] = { target: goal.target, tolerance: goal.tolerance };
  });
  return out;
}

function repeatFrom(repeat: EngineRepeat | undefined, legacyWeekdays?: number[] | null): PlannerRepeat | undefined {
  if (repeat && PLANNER_REPEAT_KINDS.includes(repeat.kind as PlannerRepeat['kind'])) {
    return {
      kind: repeat.kind as PlannerRepeat['kind'],
      interval: repeat.interval || 1,
      weekdays: repeat.kind === 'weekly' ? repeat.weekdays : undefined,
      monthDay: repeat.kind === 'monthly' && repeat.monthDay ? repeat.monthDay : undefined,
      startDay: repeat.startDay || '',
      endDay: repeat.endDay || undefined,
      count: repeat.count || undefined,
    };
  }
  // События «по дням недели» этапов 1–2 — еженедельный ряд без нижней границы (R5)
  if (legacyWeekdays?.length) return { kind: 'weekly', interval: 1, weekdays: legacyWeekdays, startDay: '' };
  return undefined;
}

function occurrencesFrom(items: EngineOccurrence[] | undefined): PlannerOccurrence[] | undefined {
  if (!items?.length) return undefined;
  return items.map((o) => ({ day: o.day, excluded: o.excluded, done: o.done, doneSteps: o.doneSteps }));
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
    repeat: repeatFrom(t.repeat),
    occurrences: occurrencesFrom(t.occurrences),
    origin: t.origin ? { seriesId: t.origin.seriesId, day: t.origin.day } : undefined,
    source: t.source ? { chat: t.source.chat, opId: t.source.opId } : undefined,
  }));
  const nutrition: Record<string, PlannerNutritionDay> = {};
  engine.nutrition.forEach((d) => {
    if (!d.entries.length && !d.isComplete && d.waterMl === null) return;
    const fixedGoals = d.fixedGoals ? goalValuesFrom(d.fixedGoals) : undefined;
    nutrition[d.day] = {
      entries: d.entries.map(entryFrom),
      isComplete: d.isComplete,
      fixedGoals: fixedGoals && Object.keys(fixedGoals).length ? fixedGoals : undefined,
      waterMl: d.waterMl === null ? undefined : d.waterMl,
    };
  });
  const s = engine.settings;
  const goals = goalValuesFrom(engine.goals);
  return {
    version: 1,
    tasks,
    events: engine.events.map((e): PlannerEvent => {
      const repeat = repeatFrom(e.repeat, e.weekdays);
      return {
        id: e.id,
        name: e.name,
        start: e.start,
        end: e.end,
        day: !repeat && e.day ? e.day : undefined,
        repeat,
        occurrences: occurrencesFrom(e.occurrences),
        origin: e.origin ? { seriesId: e.origin.seriesId, day: e.origin.day } : undefined,
      };
    }),
    projects: ['', ...lists.map((list) => list.name)],
    lists,
    nutrition,
    goals: Object.keys(goals).length ? goals : empty.goals,
    goalPeriods: (engine.goalPeriods || []).map((p) => ({
      id: p.id, startDay: p.startDay || '', endDay: p.endDay || '', goals: goalValuesFrom(p),
    })),
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

function repeatOf(repeat: PlannerRepeat | undefined) {
  if (!repeat) return null;
  return {
    kind: repeat.kind,
    interval: repeat.interval,
    weekdays: repeat.kind === 'weekly' ? repeat.weekdays || [] : [],
    monthDay: repeat.kind === 'monthly' ? repeat.monthDay || 0 : 0,
    startDay: repeat.startDay || '',
    endDay: repeat.endDay || '',
    count: repeat.count || 0,
  };
}

// Движок сливает экземпляры по дню — уходят только изменённые дни
function occurrencesOf(next: PlannerOccurrence[] | undefined, previous: PlannerOccurrence[] | undefined) {
  return (next || [])
    .filter((o) => JSON.stringify(previous?.find((p) => p.day === o.day)) !== JSON.stringify(o))
    .map((o) => ({ day: o.day, excluded: Boolean(o.excluded), done: Boolean(o.done), doneSteps: o.doneSteps || [] }));
}

function seriesFields(item: PlannerTask | PlannerEvent, previous?: PlannerTask | PlannerEvent) {
  return {
    repeat: repeatOf(item.repeat),
    occurrences: occurrencesOf(item.occurrences, previous?.occurrences),
    origin: item.origin ? { seriesId: item.origin.seriesId, day: item.origin.day } : null,
  };
}

function taskChange(state: PlannerState, t: PlannerTask, previous?: PlannerTask): PlannerChange {
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
      ...seriesFields(t, previous),
      source: t.source ? { chat: t.source.chat, opId: t.source.opId } : null,
    },
  };
}

function eventChange(e: PlannerEvent, previous?: PlannerEvent): PlannerChange {
  return {
    event: {
      id: e.id,
      name: e.name,
      start: e.start,
      end: e.end,
      weekdays: null,
      day: e.day || '',
      ...seriesFields(e, previous),
    },
  };
}

function listChange(l: PlannerList): PlannerChange {
  return { list: { id: l.id, name: l.name, order: l.order } };
}

function goalsOf(goals: PlannerGoalValues) {
  const out: Record<string, PlannerGoal | null> = {};
  PLANNER_GOAL_METRICS.forEach((metric) => {
    out[metric] = goals[metric] ? { target: goals[metric].target, tolerance: goals[metric].tolerance } : null;
  });
  return out;
}

function goalPeriodChange(record: PlannerGoalRecord): PlannerChange {
  return { goalPeriod: { id: record.id, startDay: record.startDay, endDay: record.endDay, ...goalsOf(record.goals) } };
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
  if (!previous || JSON.stringify(previous.fixedGoals) !== JSON.stringify(d.fixedGoals)) {
    change.fixedGoals = d.fixedGoals ? goalsOf(d.fixedGoals) : null;
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
    if (!before || !same(before, task)) changes.push(taskChange(next, task, before));
  });
  previous.tasks.forEach((task) => {
    if (!next.tasks.some((t) => t.id === task.id)) changes.push({ task: { id: task.id, deleted: true } });
  });

  next.events.forEach((event) => {
    const before = previous.events.find((e) => e.id === event.id);
    if (!before || !same(before, event)) changes.push(eventChange(event, before));
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
  if (!same(previous.goals, next.goals)) changes.push({ goals: goalsOf(next.goals) });

  next.goalPeriods.forEach((record) => {
    const before = previous.goalPeriods.find((r) => r.id === record.id);
    if (!before || !same(before, record)) changes.push(goalPeriodChange(record));
  });
  previous.goalPeriods.forEach((record) => {
    if (!next.goalPeriods.some((r) => r.id === record.id)) {
      changes.push({ goalPeriod: { id: record.id, deleted: true } });
    }
  });
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
