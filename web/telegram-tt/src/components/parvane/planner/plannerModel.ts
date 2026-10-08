// Parvane (spec 009): модель планировщика — задачи, события, свободные окна,
// питание и статистика. Чистые функции над `PlannerState`, без UI и хранилища.
// Референс возможностей — макет пользователя planner.html (вариант «списки»).

export type PlannerStatus = 'queue' | 'active' | 'later' | 'waiting' | 'done';
export const PLANNER_STATUSES: PlannerStatus[] = ['queue', 'active', 'later', 'waiting', 'done'];

export type PlannerStep = { text: string; isDone: boolean };

export type PlannerTask = {
  id: number;
  name: string;
  description: string;
  steps: PlannerStep[];
  status: PlannerStatus;
  // Пустая строка — «Без списка»
  project: string;
  rank: number;
  // Дата работы `YYYY-MM-DD`
  day?: string;
  // Начало `HH:MM` — только вместе с датой и длительностью
  start?: string;
  due?: string;
  // Нет значения — «Без оценки»
  minutes?: number;
};

export type PlannerEvent = {
  id: number;
  name: string;
  start: string;
  end: string;
  // Повтор по дням недели (0 — воскресенье, как `Date.getDay`) либо разовая дата
  weekdays?: number[];
  day?: string;
};

export type PlannerMetric = 'kcal' | 'protein' | 'fat' | 'carbs';
export type PlannerNutrient = PlannerMetric | 'fiber';
export const PLANNER_METRICS: PlannerMetric[] = ['kcal', 'protein', 'fat', 'carbs'];
export const PLANNER_NUTRIENTS: PlannerNutrient[] = [...PLANNER_METRICS, 'fiber'];

export type PlannerMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';
export const PLANNER_MEALS: PlannerMeal[] = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

export type PlannerFoodEntry = {
  name: string;
  meal: PlannerMeal;
  kcal: number;
  // Нет значения — «неизвестно», нулём не считается
  protein?: number;
  fat?: number;
  carbs?: number;
  fiber?: number;
  grams?: number;
  per100?: Partial<Record<PlannerNutrient, number>>;
};

export type PlannerGoal = { target: number; tolerance: number };
export type PlannerMacroGoals = Record<Exclude<PlannerMetric, 'kcal'>, PlannerGoal>;

export type PlannerNutritionDay = {
  entries: PlannerFoodEntry[];
  isComplete: boolean;
  // Цели на момент завершения дня — чтобы смена целей не переписывала историю
  goal?: PlannerGoal;
  macroGoals?: PlannerMacroGoals;
  waterMl?: number;
};

export type PlannerState = {
  version: 1;
  tasks: PlannerTask[];
  events: PlannerEvent[];
  projects: string[];
  nextId: number;
  nutrition: Record<string, PlannerNutritionDay>;
  calorieGoal: PlannerGoal;
  macroGoals: PlannerMacroGoals;
  // Дневной бюджет времени, минут
  budget: number;
};

export type PlannerTimed = {
  name: string;
  start: string;
  end: string;
  task?: PlannerTask;
  event?: PlannerEvent;
};

export type PlannerSlot = { start: number; end: number };
export type PlannerBusyGroup = PlannerSlot & { items: PlannerTimed[] };
export type PlannerNutrientStatus = 'none' | 'incomplete' | 'open' | 'below' | 'above' | 'ok';

export const DAY_WINDOW_START = 540;
export const DAY_WINDOW_END = 1260;
export const MINUTES_IN_DAY = 1440;
export const MIN_TASK_MINUTES = 5;
const LUNCH_BREAK: [number, number] = [780, 840];
const SLOT_MARGIN = 15;
const SLOT_SEARCH_DAYS = 7;
const SLOT_ANSWERS = 3;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const EVENTS_GROUP = '\u0000events';

export function createEmptyPlannerState(): PlannerState {
  return {
    version: 1,
    tasks: [],
    events: [],
    projects: [''],
    nextId: 1,
    nutrition: {},
    calorieGoal: { target: 2000, tolerance: 100 },
    macroGoals: {
      protein: { target: 120, tolerance: 20 },
      fat: { target: 70, tolerance: 15 },
      carbs: { target: 230, tolerance: 30 },
    },
    budget: 600,
  };
}

// ── даты и время ─────────────────────────────────────────────────────────────

export function toDayKey(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function fromDayKey(key: string) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(key: string, delta: number) {
  const date = fromDayKey(key);
  date.setDate(date.getDate() + delta);
  return toDayKey(date);
}

export function toMinutes(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function toTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function getMonthKeys(month: Date) {
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return Array.from({ length: count }, (_, i) => toDayKey(new Date(month.getFullYear(), month.getMonth(), i + 1)));
}

// Смещение первого дня месяца при неделе с понедельника
export function getMonthOffset(month: Date) {
  return (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
}

// ── задачи и события дня ─────────────────────────────────────────────────────

export function getTasksForDay(state: PlannerState, day: string) {
  return state.tasks.filter((task) => task.day === day);
}

export function getDeadlines(state: PlannerState, day: string) {
  return state.tasks.filter((task) => task.due === day && task.status !== 'done');
}

export function getEventsForDay(state: PlannerState, day: string) {
  const weekday = fromDayKey(day).getDay();
  return state.events
    .filter((event) => (event.day ? event.day === day : Boolean(event.weekdays?.includes(weekday))))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function countUnrated(state: PlannerState, day: string) {
  return getTasksForDay(state, day).filter((task) => task.minutes === undefined).length;
}

export function getDayLoad(state: PlannerState, day: string) {
  const events = getEventsForDay(state, day)
    .reduce((sum, event) => sum + toMinutes(event.end) - toMinutes(event.start), 0);
  const tasks = getTasksForDay(state, day).reduce((sum, task) => sum + (task.minutes || 0), 0);
  return events + tasks;
}

export function getTimedForDay(state: PlannerState, day: string, excludedTaskId?: number): PlannerTimed[] {
  const events: PlannerTimed[] = getEventsForDay(state, day)
    .map((event) => ({ name: event.name, start: event.start, end: event.end, event }));
  const tasks: PlannerTimed[] = getTasksForDay(state, day)
    .filter((task) => task.start && task.minutes !== undefined && task.id !== excludedTaskId)
    .map((task) => ({
      name: task.name, start: task.start!, end: toTime(toMinutes(task.start!) + task.minutes!), task,
    }));
  return [...events, ...tasks].sort((a, b) => a.start.localeCompare(b.start));
}

export function countConflicts(state: PlannerState, day: string) {
  const timed = getTimedForDay(state, day);
  let count = 0;
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (toMinutes(timed[i].start) < toMinutes(timed[j].end) && toMinutes(timed[j].start) < toMinutes(timed[i].end)) {
        count++;
      }
    }
  }
  return count;
}

// Доля дневного бюджета 0…1 — по ней красится день (зелёный → жёлтый → красный)
export function getLoadFraction(state: PlannerState, minutes: number) {
  return state.budget > 0 ? Math.min(1, minutes / state.budget) : 0;
}

export function getDayAvailability(state: PlannerState, day: string) {
  const timed = getTimedForDay(state, day);
  const busy: PlannerSlot[] = [];
  timed
    .map((item) => ({
      start: Math.max(DAY_WINDOW_START, toMinutes(item.start)),
      end: Math.min(DAY_WINDOW_END, toMinutes(item.end)),
    }))
    .filter((slot) => slot.start < slot.end)
    .sort((a, b) => a.start - b.start)
    .forEach((slot) => {
      const last = busy[busy.length - 1];
      if (last && slot.start <= last.end) last.end = Math.max(last.end, slot.end);
      else busy.push({ ...slot });
    });

  const free: PlannerSlot[] = [];
  let cursor = DAY_WINDOW_START;
  busy.forEach((slot) => {
    if (slot.start > cursor) free.push({ start: cursor, end: slot.start });
    cursor = Math.max(cursor, slot.end);
  });
  if (cursor < DAY_WINDOW_END) free.push({ start: cursor, end: DAY_WINDOW_END });

  // Пересекающиеся дела показываются одной группой с предупреждением
  const groups: PlannerBusyGroup[] = [];
  timed.forEach((item) => {
    const from = toMinutes(item.start);
    const until = toMinutes(item.end);
    let group = groups[groups.length - 1];
    if (!group || from >= group.end) {
      group = { start: from, end: until, items: [] };
      groups.push(group);
    }
    group.items.push(item);
    group.end = Math.max(group.end, until);
  });

  return {
    free, groups, freeMinutes: free.reduce((sum, slot) => sum + slot.end - slot.start, 0),
  };
}

// Ближайшие свободные окна под задачу: 09–21, обед 13–14, запас 15 минут
export function findSlots(state: PlannerState, task: PlannerTask, today: string, picked: string) {
  if (!task.minutes) return [];
  const minutes = task.minutes;
  const base = task.day && task.day >= today ? task.day : (picked >= today ? picked : today);
  const answers: { day: string; start: string; end: string }[] = [];
  for (let offset = 0; offset < SLOT_SEARCH_DAYS && answers.length < SLOT_ANSWERS; offset++) {
    const day = addDays(base, offset);
    if (task.due && day > task.due) break;
    const ownLoad = task.day === day ? minutes : 0;
    if (getDayLoad(state, day) - ownLoad + minutes > state.budget) continue;
    const busy = [LUNCH_BREAK, ...getTimedForDay(state, day, task.id).map((item): [number, number] => [
      Math.max(DAY_WINDOW_START, toMinutes(item.start) - SLOT_MARGIN),
      Math.min(DAY_WINDOW_END, toMinutes(item.end) + SLOT_MARGIN),
    ])].filter(([from, until]) => from < until).sort((a, b) => a[0] - b[0]);
    let cursor = DAY_WINDOW_START;
    for (const [from, until] of [...busy, [DAY_WINDOW_END, DAY_WINDOW_END]]) {
      if (from - cursor >= minutes) {
        answers.push({ day, start: toTime(cursor), end: toTime(cursor + minutes) });
        break;
      }
      cursor = Math.max(cursor, until);
    }
  }
  return answers;
}

// ── списки задач ─────────────────────────────────────────────────────────────

// Задачи с дедлайном живут в календаре; в списках — остальные незавершённые
export function getEligibleTasks(state: PlannerState) {
  return state.tasks.filter((task) => !task.due && task.status !== 'done');
}

export function getCompletedTasks(state: PlannerState) {
  return state.tasks.filter((task) => !task.due && task.status === 'done');
}

// ── проверки ввода ───────────────────────────────────────────────────────────

export type PlannerTaskError =
  'name' | 'minutes' | 'startNeedsDayAndMinutes' | 'pastMidnight' | 'dayAfterDue';

export function validateTask(
  task: Pick<PlannerTask, 'name' | 'minutes' | 'day' | 'start' | 'due'>,
): PlannerTaskError | undefined {
  if (!task.name.trim()) return 'name';
  if (task.minutes !== undefined
    && (!Number.isFinite(task.minutes) || task.minutes < MIN_TASK_MINUTES || task.minutes > MINUTES_IN_DAY)) {
    return 'minutes';
  }
  if (task.start && (!task.day || !task.minutes)) return 'startNeedsDayAndMinutes';
  if (task.start && toMinutes(task.start) + task.minutes! > MINUTES_IN_DAY) return 'pastMidnight';
  if (task.day && task.due && task.day > task.due) return 'dayAfterDue';
  return undefined;
}

export function fitsBookingWindow(
  state: PlannerState, window: PlannerSlot & { day: string }, task: Pick<PlannerTask, 'day' | 'start' | 'minutes'>,
) {
  if (task.day !== window.day || !task.minutes || !task.start) return false;
  const from = toMinutes(task.start);
  const until = from + task.minutes;
  if (from < window.start || until > window.end) return false;
  return getDayAvailability(state, window.day).free.some((slot) => from >= slot.start && until <= slot.end);
}

export type PlannerEventError = 'name' | 'time' | 'repeat';

export function validateEvent(event: Omit<PlannerEvent, 'id'>): PlannerEventError | undefined {
  if (!event.name.trim()) return 'name';
  if (!TIME_PATTERN.test(event.start) || !TIME_PATTERN.test(event.end) || event.start >= event.end) return 'time';
  if (!event.day && !event.weekdays?.length) return 'repeat';
  return undefined;
}

// ── питание ──────────────────────────────────────────────────────────────────

export function isKnownNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function roundNutrient(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

export function makeFoodEntry(raw: {
  name: string;
  meal: PlannerMeal;
  isPer100: boolean;
  grams?: number;
  values: Partial<Record<PlannerNutrient, number>>;
}): PlannerFoodEntry {
  const factor = raw.isPer100 ? (raw.grams || 0) / 100 : 1;
  const scaled: Partial<Record<PlannerNutrient, number>> = {};
  PLANNER_NUTRIENTS.forEach((nutrient) => {
    const value = raw.values[nutrient];
    if (isKnownNumber(value)) scaled[nutrient] = roundNutrient(value * factor);
  });
  return {
    name: raw.name.trim(),
    meal: raw.meal,
    kcal: scaled.kcal || 0,
    protein: scaled.protein,
    fat: scaled.fat,
    carbs: scaled.carbs,
    fiber: scaled.fiber,
    grams: raw.isPer100 ? raw.grams : undefined,
    per100: raw.isPer100 ? { ...raw.values } : undefined,
  };
}

export function getNutrientTotal(state: PlannerState, day: string, nutrient: PlannerNutrient) {
  const entries = state.nutrition[day]?.entries || [];
  let value = 0;
  let missing = 0;
  entries.forEach((entry) => {
    const amount = entry[nutrient];
    if (isKnownNumber(amount)) value += amount;
    else missing++;
  });
  return { value: roundNutrient(value), missing, count: entries.length };
}

export function getNutrientGoal(state: PlannerState, day: string, metric: PlannerMetric): PlannerGoal {
  const record = state.nutrition[day];
  if (metric === 'kcal') return (record?.isComplete && record.goal) || state.calorieGoal;
  return (record?.isComplete && record.macroGoals?.[metric]) || state.macroGoals[metric];
}

export function getNutrientStatus(state: PlannerState, day: string, metric: PlannerMetric): PlannerNutrientStatus {
  const record = state.nutrition[day];
  const total = getNutrientTotal(state, day, metric);
  if (!record || !total.count) return 'none';
  if (total.missing) return 'incomplete';
  if (!record.isComplete) return 'open';
  const goal = getNutrientGoal(state, day, metric);
  if (total.value < goal.target - goal.tolerance) return 'below';
  if (total.value > goal.target + goal.tolerance) return 'above';
  return 'ok';
}

export function getNutrientStatistics(state: PlannerState, days: string[], metric: PlannerMetric, today: string) {
  const recorded = days.filter((day) => day <= today && state.nutrition[day]?.entries.length);
  const complete = recorded
    .filter((day) => state.nutrition[day].isComplete && !getNutrientTotal(state, day, metric).missing);
  const sum = roundNutrient(recorded.reduce((total, day) => total + getNutrientTotal(state, day, metric).value, 0));
  const completeSum = roundNutrient(
    complete.reduce((total, day) => total + getNutrientTotal(state, day, metric).value, 0),
  );
  return {
    recorded,
    complete,
    sum,
    completeSum,
    inGoal: complete.filter((day) => getNutrientStatus(state, day, metric) === 'ok').length,
    average: complete.length ? roundNutrient(completeSum / complete.length) : undefined,
    goalLow: complete.reduce((total, day) => {
      const goal = getNutrientGoal(state, day, metric);
      return total + goal.target - goal.tolerance;
    }, 0),
    goalHigh: complete.reduce((total, day) => {
      const goal = getNutrientGoal(state, day, metric);
      return total + goal.target + goal.tolerance;
    }, 0),
  };
}

export function validateGoal(goal: PlannerGoal, isInteger: boolean) {
  const { target, tolerance } = goal;
  if (!isKnownNumber(target) || target <= 0 || !isKnownNumber(tolerance) || tolerance > target) return false;
  return !isInteger || (Number.isInteger(target) && Number.isInteger(tolerance));
}

// ── статистика времени ───────────────────────────────────────────────────────

// Оценки задач + длительность событий по спискам; задачи без даты не входят
export function getTimeStatistics(state: PlannerState, days: string[], hidden: ReadonlySet<string>) {
  const groups = new Map<string, number>();
  let unrated = 0;
  const add = (name: string, minutes: number) => groups.set(name, (groups.get(name) || 0) + minutes);
  days.forEach((day) => {
    getTasksForDay(state, day).forEach((task) => {
      if (task.minutes === undefined) unrated++;
      else add(task.project, task.minutes);
    });
    getEventsForDay(state, day).forEach((event) => add(EVENTS_GROUP, toMinutes(event.end) - toMinutes(event.start)));
  });
  const rows = [...groups]
    .filter(([, minutes]) => minutes > 0)
    .map(([name, minutes]) => ({
      name,
      minutes,
      colorIndex: name === EVENTS_GROUP ? 4 : Math.max(0, state.projects.indexOf(name)) % 4,
    }));
  return {
    rows,
    total: rows.reduce((sum, row) => sum + (hidden.has(row.name) ? 0 : row.minutes), 0),
    unrated,
  };
}

// ── хранение ─────────────────────────────────────────────────────────────────

// Сохранённое состояние приводится к текущей форме; негодное — пустой планировщик
export function normalizePlannerState(raw: unknown): PlannerState {
  const empty = createEmptyPlannerState();
  if (!raw || typeof raw !== 'object') return empty;
  const saved = raw as Partial<PlannerState>;
  if (saved.version !== 1 || !Array.isArray(saved.tasks)) return empty;

  const isDay = (value: unknown): value is string => typeof value === 'string' && DAY_KEY_PATTERN.test(value);
  const isTime = (value: unknown): value is string => typeof value === 'string' && TIME_PATTERN.test(value);

  const tasks = saved.tasks
    .filter((task) => task && Number.isInteger(task.id) && typeof task.name === 'string')
    .map((task, index): PlannerTask => ({
      id: task.id,
      name: task.name,
      description: typeof task.description === 'string' ? task.description : '',
      steps: Array.isArray(task.steps)
        ? task.steps.filter((step) => step && typeof step.text === 'string')
          .map((step) => ({ text: step.text, isDone: Boolean(step.isDone) }))
        : [],
      status: PLANNER_STATUSES.includes(task.status) ? task.status : 'queue',
      project: typeof task.project === 'string' ? task.project : '',
      rank: Number.isFinite(task.rank) ? task.rank : index,
      day: isDay(task.day) ? task.day : undefined,
      start: isTime(task.start) ? task.start : undefined,
      due: isDay(task.due) ? task.due : undefined,
      minutes: isKnownNumber(task.minutes) && task.minutes >= MIN_TASK_MINUTES ? task.minutes : undefined,
    }));

  const events = (Array.isArray(saved.events) ? saved.events : [])
    .filter((event) => event && Number.isInteger(event.id) && typeof event.name === 'string'
      && isTime(event.start) && isTime(event.end))
    .map((event): PlannerEvent => ({
      id: event.id,
      name: event.name,
      start: event.start,
      end: event.end,
      weekdays: Array.isArray(event.weekdays)
        ? event.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        : undefined,
      day: isDay(event.day) ? event.day : undefined,
    }));

  const projects = Array.isArray(saved.projects)
    ? Array.from(new Set(['', ...saved.projects.filter((name) => typeof name === 'string')]))
    : [''];
  tasks.forEach((task) => {
    if (!projects.includes(task.project)) projects.push(task.project);
  });

  const nutrition: Record<string, PlannerNutritionDay> = {};
  if (saved.nutrition && typeof saved.nutrition === 'object') {
    Object.entries(saved.nutrition).forEach(([day, record]) => {
      if (!isDay(day) || !record || !Array.isArray(record.entries)) return;
      nutrition[day] = {
        entries: record.entries
          .filter((entry) => entry && typeof entry.name === 'string' && isKnownNumber(entry.kcal))
          .map((entry) => ({ ...entry, meal: PLANNER_MEALS.includes(entry.meal) ? entry.meal : 'other' })),
        isComplete: Boolean(record.isComplete),
        goal: record.goal && validateGoal(record.goal, true) ? record.goal : undefined,
        macroGoals: record.macroGoals,
        waterMl: isKnownNumber(record.waterMl) ? record.waterMl : undefined,
      };
    });
  }

  const ids = [...tasks.map((task) => task.id), ...events.map((event) => event.id)];
  const macroGoals = saved.macroGoals
    && (['protein', 'fat', 'carbs'] as const).every((metric) => (
      saved.macroGoals![metric] && validateGoal(saved.macroGoals![metric], false)
    )) ? saved.macroGoals : empty.macroGoals;

  return {
    version: 1,
    tasks,
    events,
    projects,
    nextId: Math.max(1, ...ids.map((id) => id + 1)),
    nutrition,
    calorieGoal: saved.calorieGoal && validateGoal(saved.calorieGoal, true) ? saved.calorieGoal : empty.calorieGoal,
    macroGoals,
    budget: isKnownNumber(saved.budget) && saved.budget >= 60 && saved.budget <= MINUTES_IN_DAY
      ? saved.budget : empty.budget,
  };
}
