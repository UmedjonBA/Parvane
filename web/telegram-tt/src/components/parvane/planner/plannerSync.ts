/* eslint-disable no-null/no-null -- контракт JSON движка (planner_json.rs): null = «не задано», отсутствие поля = «без изменений» */
import type {
  PlannerEvent, PlannerExercise, PlannerFoodEntry, PlannerGoal, PlannerGoalRecord, PlannerGoalValues,
  PlannerHealthGoals, PlannerHealthRecord, PlannerLearnedWord, PlannerList, PlannerNutrient, PlannerNutritionDay,
  PlannerOccurrence, PlannerQuickLine, PlannerRepeat, PlannerState, PlannerTask,
} from './plannerModel';

import {
  createEmptyPlannerState, DEFAULT_PLANNER_SETTINGS, isKnownNumber, normalizeLearned, normalizeQuickLines,
  PLANNER_GOAL_METRICS, PLANNER_MEALS, PLANNER_REPEAT_KINDS, PLANNER_STATUSES,
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
  allDay?: boolean; isHoliday?: boolean; color?: number; description?: string;
};
type EngineList = { id: string; name: string; order: number; color?: number };
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
  sugar?: number | null;
  salt?: number | null;
  time?: string;
};
// spec 020: запись здоровья; `details` — JSON (упражнения тренировки либо цели здоровья)
type EngineHealth = {
  id: string; day: string; kind: string; time: string; endTime: string; value: number; value2: number;
  name: string; details: string;
};
// Слово словаря правок ввода текстом: `kind` пуст и `minutes: null` — «не выучено»
type EngineLearned = {
  id: string; kind: string; kindCount: number; minutes: number | null; minutesCount: number; touched: number;
};
// Запись истории ввода текстом: строка либо забытый шаблон (`hidden`)
type EngineQuickLine = {
  id: string; text: string; count: number; touched: number; hidden: boolean;
};
type EngineDay = {
  day: string; entries: EngineEntry[]; isComplete: boolean; fixedGoals: EngineGoals; waterMl: number | null;
};
type EngineSettings = {
  dayStart: number; dayEnd: number; lunchStart: number; lunchEnd: number; margin: number; budget: number;
} | null;
export type EngineState = {
  tasks: EngineTask[]; events: EngineEvent[]; lists: EngineList[]; nutrition: EngineDay[];
  settings: EngineSettings; goals: EngineGoals; goalPeriods?: EngineGoalPeriod[]; health?: EngineHealth[];
  // Движок прежней сборки словаря не отдаёт
  learned?: EngineLearned[];
  // История ввода текстом; движок прежней сборки её не знает — и не принимает правку `quickLine`
  quickLines?: EngineQuickLine[];
  headSeq: number; sizeBytes: number;
};

export type PlannerChange = Record<string, unknown>;

const NUTRIENTS: PlannerNutrient[] = ['kcal', 'protein', 'fat', 'carbs', 'fiber'];
// Цели здоровья — одна запись здоровья с известным id; день у неё условный (движок требует дату)
const HEALTH_GOALS_ID = 'health-goals';
const HEALTH_GOALS_KIND = 'goals';
const HEALTH_GOALS_DAY = '2000-01-01';

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
    sugar: value(e.sugar ?? null),
    salt: value(e.salt ?? null),
    time: e.time || undefined,
  };
  if (per100 && grams) {
    NUTRIENTS.forEach((nutrient) => {
      const v = entry[nutrient];
      if (isKnownNumber(v)) per100[nutrient] = Math.round((v / grams) * 100 * 10000) / 10000;
    });
  }
  return entry;
}

function parseDetails<T>(details: string): T | undefined {
  if (!details) return undefined;
  try {
    return JSON.parse(details) as T;
  } catch {
    // Негодные подробности — запись остаётся без них
    return undefined;
  }
}

function healthFrom(record: EngineHealth): PlannerHealthRecord {
  const exercises = parseDetails<{ ex?: PlannerExercise[] }>(record.details)?.ex;
  return {
    id: record.id,
    day: record.day,
    kind: record.kind,
    time: record.time || undefined,
    endTime: record.endTime || undefined,
    value: record.value,
    value2: record.value2 || undefined,
    name: record.name || undefined,
    exercises: Array.isArray(exercises) && exercises.length ? exercises : undefined,
  };
}

function healthChange(record: PlannerHealthRecord): PlannerChange {
  return {
    health: {
      id: record.id,
      day: record.day,
      kind: record.kind,
      time: record.time || '',
      endTime: record.endTime || '',
      value: record.value,
      value2: record.value2 || 0,
      name: record.name || '',
      details: record.exercises?.length ? JSON.stringify({ ex: record.exercises }) : '',
    },
  };
}

function healthGoalsChange(goals: PlannerHealthGoals): PlannerChange {
  return {
    health: {
      id: HEALTH_GOALS_ID, day: HEALTH_GOALS_DAY, kind: HEALTH_GOALS_KIND, value: 0, details: JSON.stringify(goals),
    },
  };
}

// JSON записи считается один раз на объект: записи состояния не меняются на месте (правка идёт по глубокой
// копии), поэтому по нему и сравниваются версии одной записи — при разборе состояния движка и в `diffChanges`
const jsonByObject = new WeakMap<object, string>();

/** `JSON.stringify` объекта записи с кэшем по самому объекту. */
export function stableJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  let json = jsonByObject.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    jsonByObject.set(value, json);
  }
  return json;
}

// Записи с тем же id и тем же JSON берутся из прежнего состояния: строки и клетки, обёрнутые в `memo`, после эха
// движка не перерисовываются, а индексы по записям (`WeakMap`) продолжают действовать
function reuseById<T extends { id: string }>(next: T[], previous: T[] | undefined): T[] {
  if (!previous) return next;
  if (!next.length || !previous.length) return next.length === previous.length ? previous : next;
  const byId = new Map(previous.map((item) => [item.id, item]));
  let isSame = previous.length === next.length;
  const result = next.map((item, index) => {
    const before = byId.get(item.id);
    const kept = before && stableJson(before) === stableJson(item) ? before : item;
    if (kept !== previous[index]) isSame = false;
    return kept;
  });
  return isSame ? previous : result;
}

function reuseByKey<T extends object>(
  next: Record<string, T>, previous: Record<string, T> | undefined,
): Record<string, T> {
  if (!previous) return next;
  const nextKeys = Object.keys(next);
  let isSame = nextKeys.length === Object.keys(previous).length;
  const result: Record<string, T> = {};
  nextKeys.forEach((key) => {
    const before = previous[key];
    const kept = before && stableJson(before) === stableJson(next[key]) ? before : next[key];
    if (kept !== before) isSame = false;
    result[key] = kept;
  });
  return isSame ? previous : result;
}

function reuseValue<T>(next: T, previous: T | undefined): T {
  return previous !== undefined && stableJson(previous) === stableJson(next) ? previous : next;
}

/**
 * JSON движка → состояние для экранов. `previous` — прежнее состояние экранов: записи, не изменившиеся по
 * JSON, берутся из него теми же объектами.
 */
export function fromEngineState(engine: EngineState, previous?: PlannerState): PlannerState {
  const empty = createEmptyPlannerState();
  const sorted = [...engine.lists].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
  // Задачи находят список по id, поэтому одноимённые списки (созданы на двух устройствах
  // без связи) показываются одним: в перечне остаётся первый
  const nameById = new Map(sorted.map((list) => [list.id, list.name]));
  const seenNames = new Set<string>();
  const lists: PlannerList[] = sorted.filter((list) => !seenNames.has(list.name) && seenNames.add(list.name))
    .map((list) => ({
      id: list.id, name: list.name, order: list.order, color: list.color || undefined,
    }));
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
  const healthGoalsRecord = engine.health?.find((record) => record.id === HEALTH_GOALS_ID);
  const built: PlannerState = {
    version: 1,
    tasks,
    events: engine.events.map((e): PlannerEvent => {
      const repeat = repeatFrom(e.repeat, e.weekdays);
      return {
        id: e.id,
        name: e.name,
        // Движок прежней сборки поля не отдаёт
        description: e.description || undefined,
        start: e.start,
        end: e.end,
        day: !repeat && e.day ? e.day : undefined,
        repeat,
        occurrences: occurrencesFrom(e.occurrences),
        origin: e.origin ? { seriesId: e.origin.seriesId, day: e.origin.day } : undefined,
        isAllDay: e.allDay || undefined,
        isHoliday: e.isHoliday || undefined,
        color: e.color || undefined,
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
    health: (engine.health || []).filter((record) => record.kind !== HEALTH_GOALS_KIND).map(healthFrom),
    healthGoals: (healthGoalsRecord && parseDetails<PlannerHealthGoals>(healthGoalsRecord.details))
      || empty.healthGoals,
    learned: normalizeLearned((engine.learned || []).map((word) => ({
      ...word, kind: word.kind as PlannerLearnedWord['kind'], minutes: word.minutes ?? undefined,
    }))),
    quickLines: normalizeQuickLines((engine.quickLines || []).map(({ hidden, ...line }) => ({
      ...line, isHidden: hidden,
    }))),
  };
  if (!previous) return built;
  return {
    ...built,
    tasks: reuseById(built.tasks, previous.tasks),
    events: reuseById(built.events, previous.events),
    lists: reuseById(built.lists, previous.lists),
    projects: reuseValue(built.projects, previous.projects),
    nutrition: reuseByKey(built.nutrition, previous.nutrition),
    goals: reuseValue(built.goals, previous.goals),
    goalPeriods: reuseById(built.goalPeriods, previous.goalPeriods),
    settings: reuseValue(built.settings, previous.settings),
    health: reuseById(built.health, previous.health),
    healthGoals: reuseValue(built.healthGoals, previous.healthGoals),
    learned: reuseById(built.learned, previous.learned),
    quickLines: reuseById(built.quickLines, previous.quickLines),
  };
}

/**
 * Движок понимает историю ввода текстом (отдаёт `quickLines`). Движок прежней сборки отвергает операцию с
 * незнакомой правкой целиком — вместе с записью, добавленной той же правкой, — поэтому без этого признака
 * история в данные «Плана» не пишется и остаётся на устройстве.
 */
export function hasEngineQuickLines(engine: EngineState) {
  return Array.isArray(engine.quickLines);
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
      allDay: Boolean(e.isAllDay),
      isHoliday: Boolean(e.isHoliday),
      color: e.color || 0,
      description: e.description || '',
    },
  };
}

function listChange(l: PlannerList): PlannerChange {
  return {
    list: {
      id: l.id, name: l.name, order: l.order, color: l.color || 0,
    },
  };
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
    sugar: num(e.sugar),
    salt: num(e.salt),
    time: e.time || '',
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

// Слово словаря правок: значение и его счётчик уходят парой (движок сводит их отдельными регистрами,
// пара под одной меткой остаётся согласованной), и только изменившаяся пара — тип, исправленный на одном
// устройстве, не затирает длительность, исправленную на другом. Новое слово уходит целиком: оно могло
// быть удалено раньше, и прежние значения под надгробием не должны вернуться
function learnedChange(word: PlannerLearnedWord, before?: PlannerLearnedWord): PlannerChange {
  const change: Record<string, unknown> = { id: word.id };
  if (!before || before.kind !== word.kind || before.kindCount !== word.kindCount) {
    change.kind = word.kind || '';
    change.kindCount = word.kindCount;
  }
  if (!before || before.minutes !== word.minutes || before.minutesCount !== word.minutesCount) {
    change.minutes = word.minutes === undefined ? null : word.minutes;
    change.minutesCount = word.minutesCount;
  }
  if (!before || before.touched !== word.touched) change.touched = word.touched;
  return { learned: change };
}

function quickLineChange(line: PlannerQuickLine): PlannerChange {
  return {
    quickLine: {
      id: line.id, text: line.text, count: line.count, touched: line.touched, hidden: Boolean(line.isHidden),
    },
  };
}

function settingsChange(state: PlannerState): PlannerChange {
  return { settings: { ...state.settings, budget: state.budget } };
}

/** Разница состояний → изменения для движка (объект целиком — LWW по полям у движка). */
// Правка существующего объекта несёт только изменившиеся поля: движок сводит объект по полям, и
// «попутная» запись неизменённых полей затирала бы правку тех же полей с другого устройства
// (правка времени на одном устройстве терялась, когда второе в это время отмечало выполнение)
function onlyChanged(kind: 'task' | 'event' | 'list', change: PlannerChange, before?: PlannerChange): PlannerChange {
  if (!before) return change;
  const next = change[kind] as Record<string, unknown>;
  const old = before[kind] as Record<string, unknown>;
  const fields = Object.entries(next).filter(([key, value]) => (
    // У события правило уходит всегда, парой: `weekdays: null` снимает правило прежнего формата
    // («по дням недели»), а `repeat` несёт то же правило в новом
    key === 'id' || (kind === 'event' && (key === 'weekdays' || key === 'repeat'))
    || (key === 'occurrences'
      ? (value as unknown[]).length > 0 : JSON.stringify(value) !== JSON.stringify(old[key]))
  ));
  return { [kind]: Object.fromEntries(fields) };
}

export function diffChanges(previous: PlannerState, next: PlannerState): PlannerChange[] {
  const changes: PlannerChange[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  next.lists.forEach((list) => {
    const before = previous.lists.find((l) => l.id === list.id);
    if (!before || !same(before, list)) {
      changes.push(onlyChanged('list', listChange(list), before && listChange(before)));
    }
  });
  previous.lists.forEach((list) => {
    if (!next.lists.some((l) => l.id === list.id)) changes.push({ list: { id: list.id, deleted: true } });
  });

  next.tasks.forEach((task) => {
    const before = previous.tasks.find((t) => t.id === task.id);
    if (!before || !same(before, task)) {
      changes.push(onlyChanged('task', taskChange(next, task, before), before && taskChange(previous, before)));
    }
  });
  previous.tasks.forEach((task) => {
    if (!next.tasks.some((t) => t.id === task.id)) changes.push({ task: { id: task.id, deleted: true } });
  });

  next.events.forEach((event) => {
    const before = previous.events.find((e) => e.id === event.id);
    if (!before || !same(before, event)) {
      changes.push(onlyChanged('event', eventChange(event, before), before && eventChange(before)));
    }
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

  next.health.forEach((record) => {
    const before = previous.health.find((r) => r.id === record.id);
    if (!before || !same(before, record)) changes.push(healthChange(record));
  });
  previous.health.forEach((record) => {
    if (!next.health.some((r) => r.id === record.id)) changes.push({ health: { id: record.id, deleted: true } });
  });
  if (!same(previous.healthGoals, next.healthGoals)) changes.push(healthGoalsChange(next.healthGoals));

  if (previous.learned !== next.learned) {
    const learnedBefore = new Map(previous.learned.map((word) => [word.id, word]));
    const learnedAfter = new Set(next.learned.map((word) => word.id));
    next.learned.forEach((word) => {
      const before = learnedBefore.get(word.id);
      if (!before || !same(before, word)) changes.push(learnedChange(word, before));
    });
    previous.learned.forEach((word) => {
      if (!learnedAfter.has(word.id)) changes.push({ learned: { id: word.id, deleted: true } });
    });
  }

  // История ввода текстом: запись уходит целиком (движок сводит её одним регистром), пропавшая — надгробием
  if (previous.quickLines !== next.quickLines) {
    const linesBefore = new Map(previous.quickLines.map((line) => [line.id, line]));
    const linesAfter = new Set(next.quickLines.map((line) => line.id));
    next.quickLines.forEach((line) => {
      const before = linesBefore.get(line.id);
      if (!before || !same(before, line)) changes.push(quickLineChange(line));
    });
    previous.quickLines.forEach((line) => {
      if (!linesAfter.has(line.id)) changes.push({ quickLine: { id: line.id, deleted: true } });
    });
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
