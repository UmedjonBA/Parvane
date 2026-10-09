// Parvane (spec 009): модель планировщика — задачи, события, свободные окна,
// питание и статистика. Чистые функции над `PlannerState`, без UI и хранилища.
// Референс возможностей — макет пользователя planner.html (вариант «списки»).

// Три статуса (spec 013); прежние `later` и `waiting` читаются как `queue`
export type PlannerStatus = 'queue' | 'active' | 'done';
export const PLANNER_STATUSES: PlannerStatus[] = ['queue', 'active', 'done'];

export type PlannerCalendarView = 'year' | 'month' | 'week' | 'day' | 'agenda';
export const PLANNER_CALENDAR_VIEWS: PlannerCalendarView[] = ['year', 'month', 'week', 'day', 'agenda'];
// Цвет списка: 0 — нет, 1…8 — индекс палитры
export const LIST_COLOR_COUNT = 8;
export const ALL_DAY_START = '00:00';
export const ALL_DAY_END = '23:59';
export const DEFAULT_EVENT_MINUTES = 60;
export const AGENDA_DAYS = 30;

export type PlannerStep = { text: string; isDone: boolean };

// ── повторы (spec 011) ───────────────────────────────────────────────────────

export type PlannerRepeatKind = 'daily' | 'weekly' | 'monthly' | 'yearly';
export const PLANNER_REPEAT_KINDS: PlannerRepeatKind[] = ['daily', 'weekly', 'monthly', 'yearly'];
export const MAX_REPEAT_INTERVAL = 99;
export const MAX_REPEAT_COUNT = 999;
// Горизонт поиска ближайшего экземпляра, дней
export const REPEAT_HORIZON_DAYS = 366;

// Правило повтора: хранится правило, экземпляры разворачиваются при показе
export type PlannerRepeat = {
  kind: PlannerRepeatKind;
  // каждые N дней/недель/месяцев/лет, 1..99
  interval: number;
  // weekly: дни недели (0 — воскресенье, как `Date.getDay`)
  weekdays?: number[];
  // monthly: число месяца 1..31; нет — число даты начала; в коротком месяце — последний день
  monthDay?: number;
  // первый возможный экземпляр; пустая строка — без нижней границы (только унаследованные ряды по дням недели)
  startDay: string;
  // конец ряда: до даты включительно и/или после count повторов
  endDay?: string;
  count?: number;
};

// Состояние экземпляра ряда в день: исключён (удалён «только это» или отделён), выполнен, отмеченные шаги
export type PlannerOccurrence = { day: string; excluded?: boolean; done?: boolean; doneSteps?: number[] };

// Откуда отделён экземпляр («изменить только это») — информационно
export type PlannerOrigin = { seriesId: string; day: string };

// Из какого задания чата создана задача (US3): защита от дубля и переход «карточка → задача»
export type PlannerSource = { chat: string; opId: string };

// Идентификаторы объектов — строки, уникальные между устройствами (spec 010:
// UUID на устройстве-создателе, `legacy-<устройство>-<n>` у перенесённых)
export type PlannerTask = {
  id: string;
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
  repeat?: PlannerRepeat;
  occurrences?: PlannerOccurrence[];
  origin?: PlannerOrigin;
  source?: PlannerSource;
  // У экземпляра ряда (результат разворачивания, не хранится): день экземпляра
  instanceDay?: string;
};

export type PlannerEvent = {
  id: string;
  name: string;
  start: string;
  end: string;
  // Разовая дата либо правило повтора (события «по дням недели» этапов 1–2 читаются как еженедельный ряд)
  day?: string;
  repeat?: PlannerRepeat;
  occurrences?: PlannerOccurrence[];
  origin?: PlannerOrigin;
  instanceDay?: string;
  // Весь день: времени нет (хранится 00:00–23:59), в загрузку и окна дня не входит
  isAllDay?: boolean;
  // Праздник: день события отмечается в календаре
  isHoliday?: boolean;
};

export type PlannerSeriesItem = PlannerTask | PlannerEvent;

export type PlannerMetric = 'kcal' | 'protein' | 'fat' | 'carbs';
export type PlannerNutrient = PlannerMetric | 'fiber';
export const PLANNER_METRICS: PlannerMetric[] = ['kcal', 'protein', 'fat', 'carbs'];
export const PLANNER_NUTRIENTS: PlannerNutrient[] = [...PLANNER_METRICS, 'fiber'];

export type PlannerMeal = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other';
export const PLANNER_MEALS: PlannerMeal[] = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

export type PlannerFoodEntry = {
  id: string;
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
// Показатели с целью (spec 011): питательные вещества и вода (мл)
export type PlannerGoalMetric = PlannerNutrient | 'water';
export const PLANNER_GOAL_METRICS: PlannerGoalMetric[] = [...PLANNER_NUTRIENTS, 'water'];
export type PlannerGoalValues = Partial<Record<PlannerGoalMetric, PlannerGoal>>;

// Запись цели с датами: один день (`endDay === startDay`), промежуток или бессрочно (`endDay === ''`);
// пустой `startDay` — «с самого начала». Для дня действует накрывающая запись (getGoalRecordForDay)
export type PlannerGoalRecord = { id: string; startDay: string; endDay: string; goals: PlannerGoalValues };

export type PlannerNutritionDay = {
  entries: PlannerFoodEntry[];
  isComplete: boolean;
  // Цели на момент завершения дня — чтобы смена целей не переписывала историю
  fixedGoals?: PlannerGoalValues;
  waterMl?: number;
};

// Настройки дня (T014): окна дня, перерыв и запас при поиске времени — минуты от полуночи
export type PlannerSettings = {
  dayStart: number;
  dayEnd: number;
  // Перерыв (обед) внутри окон дня; `lunchEnd <= lunchStart` — без перерыва
  lunchStart: number;
  lunchEnd: number;
  // Запас до и после каждого дела при поиске окна, минут
  margin: number;
};

// Список задач: `projects` (имена, '' — «Без списка») — вид для экранов,
// `lists` — сущности с id для синхронизации (spec 010); `projects` строится из `lists`
export type PlannerList = { id: string; name: string; order: number; color?: number };

export type PlannerState = {
  version: 1;
  tasks: PlannerTask[];
  events: PlannerEvent[];
  projects: string[];
  lists: PlannerList[];
  nutrition: Record<string, PlannerNutritionDay>;
  // Цели «с самого начала» (этапы 1–2) — запись с самым низким приоритетом
  goals: PlannerGoalValues;
  // Записи целей с датами (spec 011)
  goalPeriods: PlannerGoalRecord[];
  // Дневной бюджет времени, минут
  budget: number;
  settings: PlannerSettings;
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
// `nogoal` — факт есть, цели по показателю нет (spec 011, FR-011)
export type PlannerNutrientStatus = 'none' | 'nogoal' | 'incomplete' | 'open' | 'below' | 'above' | 'ok';

export const MINUTES_IN_DAY = 1440;
export const MIN_TASK_MINUTES = 5;
export const MIN_BUDGET_MINUTES = 60;
export const MAX_SLOT_MARGIN = 180;
// Значения макета: окна 09–21, обед 13–14, запас 15 минут
export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  dayStart: 540, dayEnd: 1260, lunchStart: 780, lunchEnd: 840, margin: 15,
};
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
    lists: [],
    nutrition: {},
    goals: {
      kcal: { target: 2000, tolerance: 100 },
      protein: { target: 120, tolerance: 20 },
      fat: { target: 70, tolerance: 15 },
      carbs: { target: 230, tolerance: 30 },
    },
    goalPeriods: [],
    budget: 600,
    settings: { ...DEFAULT_PLANNER_SETTINGS },
  };
}

/** Новый идентификатор объекта (UUID v4; движок принимает `[A-Za-z0-9_-]`). */
export function newId() {
  return crypto.randomUUID();
}

/** Список по имени; создаёт запись `lists`, если её ещё нет. */
export function ensureList(state: PlannerState, name: string): PlannerList | undefined {
  if (!name) return undefined;
  const existing = state.lists.find((list) => list.name === name);
  if (existing) return existing;
  const created = { id: newId(), name, order: state.lists.length };
  state.lists.push(created);
  if (!state.projects.includes(name)) state.projects.push(name);
  return created;
}

export function getListColor(state: PlannerState, name: string) {
  return (name && state.lists.find((list) => list.name === name)?.color) || 0;
}

export function hasLunchBreak(settings: PlannerSettings) {
  return settings.lunchEnd > settings.lunchStart;
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

/** Неделя дня с понедельника по воскресенье. */
export function getWeekKeys(day: string) {
  const monday = addDays(day, -mondayBased(weekdayOf(day)));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function getYearMonths(year: number) {
  return Array.from({ length: 12 }, (_, i) => new Date(year, i, 1));
}

export function getYearKeys(year: number) {
  return getYearMonths(year).flatMap(getMonthKeys);
}

/** Сетка месяца полными неделями: дни соседних месяцев в начале и в конце. */
export function getMonthGridKeys(month: Date) {
  const days = getMonthKeys(month);
  const first = addDays(days[0], -getMonthOffset(month));
  const count = Math.ceil((getMonthOffset(month) + days.length) / 7) * 7;
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

/** Сдвиг якоря на период вида: год, месяц, неделя, день; расписание листается неделями. */
export function shiftPeriod(view: PlannerCalendarView, day: string, delta: number) {
  if (view === 'day') return addDays(day, delta);
  if (view === 'week' || view === 'agenda') return addDays(day, delta * 7);
  const d = parts(day);
  const target = view === 'year'
    ? { year: d.year + delta, month: d.month }
    : { year: d.year + Math.floor((d.month - 1 + delta) / 12), month: ((d.month - 1 + delta) % 12 + 12) % 12 + 1 };
  const date = Math.min(d.date, daysInMonth(target.year, target.month));
  return `${target.year}-${String(target.month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

/** Конец события по умолчанию: через час после начала, но не позже конца суток. */
export function getDefaultEventEnd(start: string) {
  return toTime(Math.min(toMinutes(start) + DEFAULT_EVENT_MINUTES, MINUTES_IN_DAY - 1));
}

// ── повторы: разворачивание ряда ─────────────────────────────────────────────

// Дни от эпохи без влияния часового пояса и перевода часов
function epochDays(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, date) / 86400000);
}

// Номер недели с понедельника (1970-01-01 — четверг)
function weekIndex(day: string) {
  return Math.floor((epochDays(day) + 3) / 7);
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parts(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return { year, month, date };
}

function weekdayOf(day: string) {
  const d = parts(day);
  return new Date(Date.UTC(d.year, d.month - 1, d.date)).getUTCDay();
}

// Позиция дня недели при неделе с понедельника
function mondayBased(weekday: number) {
  return (weekday + 6) % 7;
}

export function isRepeating(item: PlannerSeriesItem) {
  return Boolean(item.repeat);
}

export function getOccurrence(item: PlannerSeriesItem, day: string) {
  return item.occurrences?.find((o) => o.day === day);
}

// Порядковый номер экземпляра (с 1) по правилу — без учёта исключений; `undefined` — ряд в этот день не даёт экземпляра
function ordinalOf(repeat: PlannerRepeat, day: string): number | undefined {
  const { kind, interval } = repeat;
  if (!DAY_KEY_PATTERN.test(day) || !Number.isInteger(interval) || interval < 1) return undefined;
  if (repeat.startDay && day < repeat.startDay) return undefined;
  if (repeat.endDay && day > repeat.endDay) return undefined;
  const d = parts(day);
  if (kind === 'weekly') {
    const weekdays = [...(repeat.weekdays || [])].sort((a, b) => mondayBased(a) - mondayBased(b));
    const index = weekdays.indexOf(weekdayOf(day));
    if (index < 0) return undefined;
    if (!repeat.startDay) return 1;
    const weeks = weekIndex(day) - weekIndex(repeat.startDay);
    if (weeks % interval !== 0) return undefined;
    // Дни первой недели до даты начала не порождаются и в счёт не идут
    const startPosition = mondayBased(weekdayOf(repeat.startDay));
    const skippedInFirstWeek = weekdays.filter((w) => mondayBased(w) < startPosition).length;
    return (weeks / interval) * weekdays.length + index + 1 - skippedInFirstWeek;
  }
  if (!repeat.startDay) return undefined;
  const start = parts(repeat.startDay);
  if (kind === 'daily') {
    const diff = epochDays(day) - epochDays(repeat.startDay);
    return diff % interval === 0 ? diff / interval + 1 : undefined;
  }
  if (kind === 'monthly') {
    const months = (d.year * 12 + d.month) - (start.year * 12 + start.month);
    if (months % interval !== 0) return undefined;
    const wanted = Math.min(repeat.monthDay || start.date, daysInMonth(d.year, d.month));
    return d.date === wanted ? months / interval + 1 : undefined;
  }
  const years = d.year - start.year;
  if (years % interval !== 0 || d.month !== start.month) return undefined;
  const wanted = Math.min(start.date, daysInMonth(d.year, d.month));
  return d.date === wanted ? years / interval + 1 : undefined;
}

/** Даёт ли правило экземпляр в этот день (исключения не учитываются). */
export function occursOn(repeat: PlannerRepeat, day: string) {
  const ordinal = ordinalOf(repeat, day);
  if (ordinal === undefined) return false;
  return !repeat.count || ordinal <= repeat.count;
}

/** Дни ряда в промежутке включительно (исключения не учитываются). */
export function expandRepeat(repeat: PlannerRepeat, fromDay: string, toDay: string) {
  const days: string[] = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    if (occursOn(repeat, day)) days.push(day);
  }
  return days;
}

/** Есть ли у ряда экземпляр в день (с учётом исключений). */
export function hasInstanceOn(item: PlannerSeriesItem, day: string) {
  if (!item.repeat) return false;
  return occursOn(item.repeat, day) && !getOccurrence(item, day)?.excluded;
}

export function instanceKey(item: PlannerSeriesItem) {
  return item.instanceDay ? `${item.id}@${item.instanceDay}` : item.id;
}

/** Экземпляр задачи-ряда на день: выполнение и шаги — из состояния экземпляра. */
export function taskInstance(task: PlannerTask, day: string): PlannerTask {
  const occurrence = getOccurrence(task, day);
  const doneSteps = new Set(occurrence?.doneSteps || []);
  return {
    ...task,
    day,
    due: undefined,
    status: occurrence?.done ? 'done' : (task.status === 'done' ? 'queue' : task.status),
    steps: task.steps.map((step, index) => ({ text: step.text, isDone: doneSteps.has(index) })),
    instanceDay: day,
  };
}

export function eventInstance(event: PlannerEvent, day: string): PlannerEvent {
  return { ...event, day, instanceDay: day };
}

export function isInstanceDone(task: PlannerTask, day: string) {
  return Boolean(getOccurrence(task, day)?.done);
}

/** Ближайший невыполненный экземпляр задачи-ряда с `today` (горизонт года). */
export function nextOpenInstance(task: PlannerTask, today: string): PlannerTask | undefined {
  if (!task.repeat) return undefined;
  for (let i = 0; i < REPEAT_HORIZON_DAYS; i++) {
    const day = addDays(today, i);
    if (hasInstanceOn(task, day) && !isInstanceDone(task, day)) return taskInstance(task, day);
  }
  return undefined;
}

export type PlannerRepeatError = 'interval' | 'weekdays' | 'monthDay' | 'startDay' | 'endDay' | 'count';

export function validateRepeat(repeat: PlannerRepeat): PlannerRepeatError | undefined {
  if (!Number.isInteger(repeat.interval) || repeat.interval < 1 || repeat.interval > MAX_REPEAT_INTERVAL) {
    return 'interval';
  }
  if (repeat.kind === 'weekly') {
    const days = repeat.weekdays || [];
    const isWeekday = (d: number) => Number.isInteger(d) && d >= 0 && d <= 6;
    if (!days.length || !days.every(isWeekday) || new Set(days).size !== days.length) {
      return 'weekdays';
    }
  }
  if (repeat.monthDay !== undefined
    && (!Number.isInteger(repeat.monthDay) || repeat.monthDay < 1 || repeat.monthDay > 31)) return 'monthDay';
  if (repeat.startDay ? !DAY_KEY_PATTERN.test(repeat.startDay) : repeat.kind !== 'weekly') return 'startDay';
  if (repeat.endDay && (!DAY_KEY_PATTERN.test(repeat.endDay) || (repeat.startDay && repeat.endDay < repeat.startDay))) {
    return 'endDay';
  }
  if (repeat.count !== undefined
    && (!Number.isInteger(repeat.count) || repeat.count < 1 || repeat.count > MAX_REPEAT_COUNT)) return 'count';
  return undefined;
}

// ── повторы: правки экземпляров и ряда ───────────────────────────────────────

function seriesOf(state: PlannerState, kind: 'task' | 'event', id: string): PlannerSeriesItem | undefined {
  return kind === 'task' ? state.tasks.find((t) => t.id === id) : state.events.find((e) => e.id === id);
}

/** Записать состояние экземпляра на день (слияние по дню у движка). */
export function setOccurrence(
  state: PlannerState, kind: 'task' | 'event', id: string, day: string, patch: Omit<PlannerOccurrence, 'day'>,
) {
  const item = seriesOf(state, kind, id);
  if (!item) return false;
  const occurrences = item.occurrences || [];
  const index = occurrences.findIndex((o) => o.day === day);
  const next: PlannerOccurrence = { ...(index >= 0 ? occurrences[index] : {}), day, ...patch };
  if (index >= 0) occurrences[index] = next;
  else occurrences.push(next);
  item.occurrences = occurrences.sort((a, b) => a.day.localeCompare(b.day));
  return true;
}

/** «Удалить только это»: исключить день из ряда. */
export function excludeInstance(state: PlannerState, kind: 'task' | 'event', id: string, day: string) {
  return setOccurrence(state, kind, id, day, { excluded: true });
}

function stripSeries<T extends PlannerSeriesItem>(item: T): T {
  const copy = { ...item };
  delete copy.repeat;
  delete copy.occurrences;
  delete copy.instanceDay;
  return copy;
}

/** «Изменить только это»: самостоятельная копия экземпляра с полями `patch` и исключение дня у ряда. */
export function detachInstance(
  state: PlannerState, kind: 'task' | 'event', id: string, day: string, patch: Partial<PlannerTask & PlannerEvent>,
) {
  const item = seriesOf(state, kind, id);
  if (!item) return undefined;
  const origin: PlannerOrigin = { seriesId: id, day };
  if (kind === 'task') {
    const instance = taskInstance(item as PlannerTask, day);
    const detached: PlannerTask = { ...stripSeries(instance), ...patch, id: newId(), origin, day: patch.day ?? day };
    state.tasks.push(detached);
    excludeInstance(state, kind, id, day);
    return detached;
  }
  const detached: PlannerEvent = {
    ...stripSeries(item as PlannerEvent), ...patch, id: newId(), origin, day: patch.day ?? day,
  };
  state.events.push(detached);
  excludeInstance(state, kind, id, day);
  return detached;
}

// Число экземпляров ряда до дня (для переноса `count` при разделении)
function instancesBefore(repeat: PlannerRepeat, day: string) {
  if (!repeat.startDay) return 0;
  return expandRepeat(repeat, repeat.startDay, addDays(day, -1)).length;
}

/** «Это и последующие»: старый ряд заканчивается днём раньше, новый ряд с этого дня с полями `patch`. */
export function splitSeries(
  state: PlannerState, kind: 'task' | 'event', id: string, day: string, patch: Partial<PlannerTask & PlannerEvent>,
) {
  const item = seriesOf(state, kind, id);
  if (!item?.repeat) return undefined;
  const repeat = item.repeat;
  const before = instancesBefore(repeat, day);
  const nextRepeat: PlannerRepeat = {
    ...repeat,
    startDay: day,
    count: repeat.count !== undefined ? Math.max(1, repeat.count - before) : undefined,
    ...(patch.repeat || {}),
  };
  if (!repeat.startDay || day <= repeat.startDay) {
    // Разделять нечего — правка всего ряда
    Object.assign(item, patch, { repeat: { ...nextRepeat, startDay: repeat.startDay || day } });
    return item;
  }
  item.repeat = {
    ...repeat, endDay: addDays(day, -1), count: repeat.count !== undefined ? Math.max(1, before) : undefined,
  };
  item.occurrences = item.occurrences?.filter((o) => o.day < day);
  if (kind === 'task') {
    const base = stripSeries(item as PlannerTask);
    const created: PlannerTask = {
      ...base, ...patch, id: newId(), repeat: nextRepeat, status: 'queue', day: undefined, occurrences: [],
    };
    state.tasks.push(created);
    return created;
  }
  const created: PlannerEvent = {
    ...stripSeries(item as PlannerEvent), ...patch, id: newId(), repeat: nextRepeat, occurrences: [],
  };
  state.events.push(created);
  return created;
}

/** «Удалить это и последующие»: ряд заканчивается днём раньше; если раньше начала — ряд удаляется. */
export function truncateSeries(state: PlannerState, kind: 'task' | 'event', id: string, day: string) {
  const item = seriesOf(state, kind, id);
  if (!item?.repeat) return false;
  if (!item.repeat.startDay || day <= item.repeat.startDay) {
    removeSeries(state, kind, id);
    return true;
  }
  const before = instancesBefore(item.repeat, day);
  item.repeat = {
    ...item.repeat, endDay: addDays(day, -1), count: item.repeat.count !== undefined ? Math.max(1, before) : undefined,
  };
  item.occurrences = item.occurrences?.filter((o) => o.day < day);
  return true;
}

/** Удалить ряд целиком (отделённые экземпляры остаются). */
export function removeSeries(state: PlannerState, kind: 'task' | 'event', id: string) {
  if (kind === 'task') state.tasks = state.tasks.filter((t) => t.id !== id);
  else state.events = state.events.filter((e) => e.id !== id);
}

/** Отметить задачу (или экземпляр ряда) выполненной. */
export function setTaskDone(state: PlannerState, task: PlannerTask, isDone: boolean) {
  if (task.repeat && task.instanceDay) {
    return setOccurrence(state, 'task', task.id, task.instanceDay, { done: isDone });
  }
  const target = state.tasks.find((t) => t.id === task.id);
  if (!target) return false;
  target.status = isDone ? 'done' : 'queue';
  return true;
}

/** Отметить шаг задачи (или экземпляра ряда — по дню). */
export function setTaskStepDone(state: PlannerState, task: PlannerTask, index: number, isDone: boolean) {
  if (task.repeat && task.instanceDay) {
    const current = new Set(getOccurrence(task, task.instanceDay)?.doneSteps || []);
    if (isDone) current.add(index);
    else current.delete(index);
    return setOccurrence(state, 'task', task.id, task.instanceDay, { doneSteps: [...current].sort((a, b) => a - b) });
  }
  const target = state.tasks.find((t) => t.id === task.id);
  if (!target?.steps[index]) return false;
  target.steps[index].isDone = isDone;
  return true;
}

// ── задачи и события дня ─────────────────────────────────────────────────────

/** Задачи дня: разовые с датой и экземпляры рядов. */
export function getTasksForDay(state: PlannerState, day: string): PlannerTask[] {
  const result: PlannerTask[] = [];
  state.tasks.forEach((task) => {
    if (task.repeat) {
      if (hasInstanceOn(task, day)) result.push(taskInstance(task, day));
    } else if (task.day === day) result.push(task);
  });
  return result;
}

export function getDeadlines(state: PlannerState, day: string) {
  return state.tasks.filter((task) => !task.repeat && task.due === day && task.status !== 'done');
}

export function getEventsForDay(state: PlannerState, day: string): PlannerEvent[] {
  const result: PlannerEvent[] = [];
  state.events.forEach((event) => {
    if (event.repeat) {
      if (hasInstanceOn(event, day)) result.push(eventInstance(event, day));
    } else if (event.day === day) result.push(event);
  });
  return result.sort(compareEvents);
}

export type PlannerDayIndexEntry = {
  tasks: PlannerTask[];
  events: PlannerEvent[];
  deadlines: PlannerTask[];
  isHoliday: boolean;
  minutes: number;
};

/**
 * Дела по дням промежутка за один проход по задачам и событиям — для видов «Год» и
 * «Расписание», где вызов функций дня на каждый день слишком дорог.
 */
export function buildDayIndex(state: PlannerState, fromDay: string, toDay: string) {
  const index = new Map<string, PlannerDayIndexEntry>();
  const entryOf = (day: string) => {
    let entry = index.get(day);
    if (!entry) {
      entry = {
        tasks: [], events: [], deadlines: [], isHoliday: false, minutes: 0,
      };
      index.set(day, entry);
    }
    return entry;
  };
  const isInside = (day?: string): day is string => Boolean(day && day >= fromDay && day <= toDay);
  const daysOf = (item: PlannerSeriesItem) => (item.repeat
    ? expandRepeat(item.repeat, fromDay, toDay).filter((day) => !getOccurrence(item, day)?.excluded)
    : (isInside(item.day) ? [item.day] : []));
  state.tasks.forEach((task) => {
    daysOf(task).forEach((day) => {
      const entry = entryOf(day);
      entry.tasks.push(task.repeat ? taskInstance(task, day) : task);
      entry.minutes += task.minutes || 0;
    });
    if (!task.repeat && task.status !== 'done' && isInside(task.due)) entryOf(task.due).deadlines.push(task);
  });
  state.events.forEach((event) => {
    daysOf(event).forEach((day) => {
      const entry = entryOf(day);
      entry.events.push(event.repeat ? eventInstance(event, day) : event);
      if (event.isHoliday) entry.isHoliday = true;
      if (!event.isAllDay) entry.minutes += toMinutes(event.end) - toMinutes(event.start);
    });
  });
  index.forEach((entry) => entry.events.sort(compareEvents));
  return index;
}

// События на весь день — первыми, остальные — по началу
function compareEvents(a: PlannerEvent, b: PlannerEvent) {
  return Number(Boolean(b.isAllDay)) - Number(Boolean(a.isAllDay)) || a.start.localeCompare(b.start);
}

export function isHolidayOn(state: PlannerState, day: string) {
  return getEventsForDay(state, day).some((event) => event.isHoliday);
}

export function countUnrated(state: PlannerState, day: string) {
  return getTasksForDay(state, day).filter((task) => task.minutes === undefined).length;
}

export function getDayLoad(state: PlannerState, day: string) {
  const events = getEventsForDay(state, day)
    .reduce((sum, event) => sum + (event.isAllDay ? 0 : toMinutes(event.end) - toMinutes(event.start)), 0);
  const tasks = getTasksForDay(state, day).reduce((sum, task) => sum + (task.minutes || 0), 0);
  return events + tasks;
}

export function getTimedForDay(state: PlannerState, day: string, excludedTaskId?: string): PlannerTimed[] {
  const events: PlannerTimed[] = getEventsForDay(state, day)
    .filter((event) => !event.isAllDay)
    .map((event) => ({ name: event.name, start: event.start, end: event.end, event }));
  const tasks: PlannerTimed[] = getTasksForDay(state, day)
    .filter((task) => task.start && task.minutes !== undefined && instanceKey(task) !== excludedTaskId)
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
  const { dayStart, dayEnd } = state.settings;
  const timed = getTimedForDay(state, day);
  const busy: PlannerSlot[] = [];
  timed
    .map((item) => ({
      start: Math.max(dayStart, toMinutes(item.start)),
      end: Math.min(dayEnd, toMinutes(item.end)),
    }))
    .filter((slot) => slot.start < slot.end)
    .sort((a, b) => a.start - b.start)
    .forEach((slot) => {
      const last = busy[busy.length - 1];
      if (last && slot.start <= last.end) last.end = Math.max(last.end, slot.end);
      else busy.push({ ...slot });
    });

  const free: PlannerSlot[] = [];
  let cursor = dayStart;
  busy.forEach((slot) => {
    if (slot.start > cursor) free.push({ start: cursor, end: slot.start });
    cursor = Math.max(cursor, slot.end);
  });
  if (cursor < dayEnd) free.push({ start: cursor, end: dayEnd });

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

// Ближайшие свободные окна под задачу: в окнах дня, мимо перерыва, с запасом (settings)
export function findSlots(state: PlannerState, task: PlannerTask, today: string, picked: string) {
  if (!task.minutes) return [];
  const minutes = task.minutes;
  const {
    dayStart, dayEnd, lunchStart, lunchEnd, margin,
  } = state.settings;
  const lunch: [number, number][] = hasLunchBreak(state.settings) ? [[lunchStart, lunchEnd]] : [];
  const base = task.day && task.day >= today ? task.day : (picked >= today ? picked : today);
  const answers: { day: string; start: string; end: string }[] = [];
  for (let offset = 0; offset < SLOT_SEARCH_DAYS && answers.length < SLOT_ANSWERS; offset++) {
    const day = addDays(base, offset);
    if (task.due && day > task.due) break;
    const ownLoad = task.day === day ? minutes : 0;
    if (getDayLoad(state, day) - ownLoad + minutes > state.budget) continue;
    const busy = [...lunch, ...getTimedForDay(state, day, instanceKey(task)).map((item): [number, number] => [
      Math.max(dayStart, toMinutes(item.start) - margin),
      Math.min(dayEnd, toMinutes(item.end) + margin),
    ])].filter(([from, until]) => from < until).sort((a, b) => a[0] - b[0]);
    let cursor = dayStart;
    for (const [from, until] of [...busy, [dayEnd, dayEnd]]) {
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

// Задачи с дедлайном живут в календаре; в списках — остальные незавершённые.
// Задача-ряд — одной строкой: ближайший невыполненный экземпляр (решение пользователя 8 окт 2026)
export function getEligibleTasks(state: PlannerState, today?: string) {
  const result: PlannerTask[] = [];
  state.tasks.forEach((task) => {
    if (task.repeat) {
      const next = nextOpenInstance(task, today || toDayKey(new Date()));
      if (next) result.push(next);
    } else if (!task.due && task.status !== 'done') result.push(task);
  });
  return result;
}

export function getCompletedTasks(state: PlannerState) {
  return state.tasks.filter((task) => !task.repeat && !task.due && task.status === 'done');
}

// Соседи задачи по порядку — незавершённые задачи того же списка и статуса
export function getOrderedGroup(state: PlannerState, task: PlannerTask, today?: string) {
  return getEligibleTasks(state, today)
    .filter((item) => item.project === task.project && item.status === task.status)
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
}

// Порядок в очереди (↑↓ из макета): задача меняется местами с соседом;
// у края группы ничего не происходит
export function moveTask(state: PlannerState, taskId: string, direction: -1 | 1, today?: string) {
  const task = state.tasks.find(({ id }) => id === taskId);
  if (!task) return false;
  const group = getOrderedGroup(state, task, today).map((item) => state.tasks.find((t) => t.id === item.id)!);
  const index = group.indexOf(task);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= group.length) return false;
  // Ранги группы делаются различными, иначе обмен равных рангов ничего не меняет
  group.forEach((item, i) => {
    item.rank = i;
  });
  group[index].rank = target;
  group[target].rank = index;
  return true;
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

export type PlannerSettingsError = 'window' | 'lunch' | 'margin';

export function validateSettings(settings: PlannerSettings): PlannerSettingsError | undefined {
  const {
    dayStart, dayEnd, lunchStart, lunchEnd, margin,
  } = settings;
  const isMinute = (value: number) => Number.isInteger(value) && value >= 0 && value <= MINUTES_IN_DAY;
  if (!isMinute(dayStart) || !isMinute(dayEnd) || dayStart >= dayEnd) return 'window';
  if (!isMinute(lunchStart) || !isMinute(lunchEnd)) return 'lunch';
  if (hasLunchBreak(settings) && (lunchStart < dayStart || lunchEnd > dayEnd)) return 'lunch';
  if (!Number.isInteger(margin) || margin < 0 || margin > MAX_SLOT_MARGIN) return 'margin';
  return undefined;
}

export function validateBudget(budget: number) {
  return Number.isInteger(budget) && budget >= MIN_BUDGET_MINUTES && budget <= MINUTES_IN_DAY;
}

export type PlannerEventError = 'name' | 'time' | 'repeat' | PlannerRepeatError;

export function validateEvent(event: Omit<PlannerEvent, 'id'>): PlannerEventError | undefined {
  if (!event.name.trim()) return 'name';
  if (!event.isAllDay
    && (!TIME_PATTERN.test(event.start) || !TIME_PATTERN.test(event.end) || event.start >= event.end)) return 'time';
  if (event.repeat) return validateRepeat(event.repeat);
  if (!event.day) return 'repeat';
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
  id?: string;
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
    id: raw.id || newId(),
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

/** Факт дня по показателю: сумма записей; вода — `waterMl` (одно число, пропусков нет). */
export function getNutrientTotal(state: PlannerState, day: string, nutrient: PlannerGoalMetric) {
  const record = state.nutrition[day];
  if (nutrient === 'water') {
    const known = isKnownNumber(record?.waterMl);
    return { value: known ? record.waterMl! : 0, missing: 0, count: known ? 1 : 0 };
  }
  const entries = record?.entries || [];
  let value = 0;
  let missing = 0;
  entries.forEach((entry) => {
    const amount = entry[nutrient];
    if (isKnownNumber(amount)) value += amount;
    else missing++;
  });
  return { value: roundNutrient(value), missing, count: entries.length };
}

/** Запись цели, действующая в день (FR-010): накрывающая, затем позже начатая, короче, позже в списке. */
export function getGoalRecordForDay(state: PlannerState, day: string): PlannerGoalRecord | undefined {
  const length = (r: PlannerGoalRecord) => (r.endDay && r.startDay
    ? epochDays(r.endDay) - epochDays(r.startDay) : Number.POSITIVE_INFINITY);
  let best: PlannerGoalRecord | undefined;
  state.goalPeriods.forEach((record) => {
    if ((record.startDay && day < record.startDay) || (record.endDay && day > record.endDay)) return;
    if (!best || record.startDay > best.startDay
      || (record.startDay === best.startDay && length(record) <= length(best))) best = record;
  });
  if (best) return best;
  return Object.keys(state.goals).length ? { id: '', startDay: '', endDay: '', goals: state.goals } : undefined;
}

/**
 * День питания завершён (spec 013): прошедший — сам, без действия пользователя; отметка
 * `isComplete` прежних версий тоже учитывается.
 */
export function isDayClosed(state: PlannerState, day: string, today = toDayKey(new Date())) {
  return day < today || Boolean(state.nutrition[day]?.isComplete);
}

/** Цели, действующие в день: у завершённого дня — зафиксированные, иначе — по записи. */
export function getGoalsForDay(state: PlannerState, day: string, today?: string): PlannerGoalValues {
  const record = state.nutrition[day];
  if (record?.fixedGoals && isDayClosed(state, day, today)) return record.fixedGoals;
  return getGoalRecordForDay(state, day)?.goals || {};
}

/**
 * Перед правкой целей: прошедшим дням с записями фиксируются цели, действовавшие до правки, —
 * иначе смена цели переоценила бы историю. Возвращает число затронутых дней.
 */
export function freezePastGoals(state: PlannerState, today = toDayKey(new Date())) {
  let count = 0;
  Object.entries(state.nutrition).forEach(([day, record]) => {
    if (day >= today || record.fixedGoals || !(record.entries.length || record.waterMl)) return;
    record.fixedGoals = structuredClone(getGoalRecordForDay(state, day)?.goals || {});
    record.isComplete = true;
    count++;
  });
  return count;
}

export function getNutrientGoal(
  state: PlannerState, day: string, metric: PlannerGoalMetric, today?: string,
): PlannerGoal | undefined {
  return getGoalsForDay(state, day, today)[metric];
}

export function getNutrientStatus(
  state: PlannerState, day: string, metric: PlannerGoalMetric, today?: string,
): PlannerNutrientStatus {
  const record = state.nutrition[day];
  const total = getNutrientTotal(state, day, metric);
  if (!record || !total.count) return 'none';
  const goal = getNutrientGoal(state, day, metric, today);
  if (!goal) return 'nogoal';
  if (total.missing) return 'incomplete';
  if (!isDayClosed(state, day, today)) return 'open';
  if (total.value < goal.target - goal.tolerance) return 'below';
  if (total.value > goal.target + goal.tolerance) return 'above';
  return 'ok';
}

export function getNutrientStatistics(state: PlannerState, days: string[], metric: PlannerGoalMetric, today: string) {
  const recorded = days.filter((day) => day <= today && getNutrientTotal(state, day, metric).count);
  const complete = recorded
    .filter((day) => isDayClosed(state, day, today) && !getNutrientTotal(state, day, metric).missing);
  // Дни «в норме» считаются по собственной цели каждого дня; дни без цели в норму не входят
  const withGoal = complete.filter((day) => getNutrientGoal(state, day, metric, today));
  const sum = roundNutrient(recorded.reduce((total, day) => total + getNutrientTotal(state, day, metric).value, 0));
  const completeSum = roundNutrient(
    complete.reduce((total, day) => total + getNutrientTotal(state, day, metric).value, 0),
  );
  return {
    recorded,
    complete,
    withGoal,
    sum,
    completeSum,
    inGoal: withGoal.filter((day) => getNutrientStatus(state, day, metric, today) === 'ok').length,
    average: complete.length ? roundNutrient(completeSum / complete.length) : undefined,
    goalLow: withGoal.reduce((total, day) => {
      const goal = getNutrientGoal(state, day, metric, today)!;
      return total + goal.target - goal.tolerance;
    }, 0),
    goalHigh: withGoal.reduce((total, day) => {
      const goal = getNutrientGoal(state, day, metric, today)!;
      return total + goal.target + goal.tolerance;
    }, 0),
  };
}

export type PlannerGoalRecordError = 'startDay' | 'endDay' | 'empty' | PlannerGoalMetric;

/** Запись цели: даты, конец не раньше начала, хотя бы один показатель, каждая цель годна. */
export function validateGoalRecord(record: Omit<PlannerGoalRecord, 'id'>): PlannerGoalRecordError | undefined {
  if (record.startDay && !DAY_KEY_PATTERN.test(record.startDay)) return 'startDay';
  if (record.endDay && (!DAY_KEY_PATTERN.test(record.endDay) || (record.startDay && record.endDay < record.startDay))) {
    return 'endDay';
  }
  const metrics = PLANNER_GOAL_METRICS.filter((metric) => record.goals[metric]);
  if (!metrics.length) return 'empty';
  return metrics.find((metric) => !validateGoal(record.goals[metric]!, metric === 'kcal' || metric === 'water'));
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
    getEventsForDay(state, day).filter((event) => !event.isAllDay)
      .forEach((event) => add(EVENTS_GROUP, toMinutes(event.end) - toMinutes(event.start)));
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

  const isId = (value: unknown): value is string | number => (
    (typeof value === 'string' && value.length > 0 && value.length <= 64) || Number.isInteger(value)
  );
  const tasks = saved.tasks
    .filter((task) => task && isId(task.id) && typeof task.name === 'string')
    .map((task, index): PlannerTask => ({
      id: String(task.id),
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
      ...normalizeSeries(task),
    }));

  const events = (Array.isArray(saved.events) ? saved.events : [])
    .filter((event) => event && isId(event.id) && typeof event.name === 'string'
      && isTime(event.start) && isTime(event.end))
    .map((event): PlannerEvent => {
      // События «по дням недели» этапов 1–2 — еженедельный ряд без нижней границы (research R5)
      const rawWeekdays = (event as unknown as { weekdays?: unknown }).weekdays;
      const legacyWeekdays = Array.isArray(rawWeekdays)
        ? rawWeekdays.filter((day): day is number => (
          Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6
        ))
        : [];
      const series = normalizeSeries(event);
      const repeat = series.repeat || (legacyWeekdays.length
        ? { kind: 'weekly' as const, interval: 1, weekdays: legacyWeekdays, startDay: '' } : undefined);
      return {
        id: String(event.id),
        name: event.name,
        start: event.start,
        end: event.end,
        day: !repeat && isDay(event.day) ? event.day : undefined,
        ...series,
        repeat,
        isAllDay: event.isAllDay ? true : undefined,
        isHoliday: event.isHoliday ? true : undefined,
      };
    });

  const projects = Array.isArray(saved.projects)
    ? Array.from(new Set(['', ...saved.projects.filter((name) => typeof name === 'string')]))
    : [''];
  tasks.forEach((task) => {
    if (!projects.includes(task.project)) projects.push(task.project);
  });
  const savedLists = Array.isArray(saved.lists) ? saved.lists : [];
  const lists: PlannerList[] = savedLists
    .filter((list) => list && typeof list.id === 'string' && typeof list.name === 'string' && list.name)
    .map((list, index) => ({
      id: list.id,
      name: list.name,
      order: Number.isFinite(list.order) ? list.order : index,
      color: Number.isInteger(list.color) && list.color! >= 1 && list.color! <= LIST_COLOR_COUNT
        ? list.color : undefined,
    }));
  projects.filter(Boolean).forEach((name) => {
    if (!lists.some((list) => list.name === name)) lists.push({ id: newId(), name, order: lists.length });
  });

  const nutrition: Record<string, PlannerNutritionDay> = {};
  if (saved.nutrition && typeof saved.nutrition === 'object') {
    Object.entries(saved.nutrition).forEach(([day, record]) => {
      if (!isDay(day) || !record || !Array.isArray(record.entries)) return;
      // Этап 1 хранил цели завершённого дня как `goal` (ккал) и `macroGoals` — сводятся в `fixedGoals`
      const legacy = record as { goal?: PlannerGoal; macroGoals?: Partial<Record<PlannerMetric, PlannerGoal>> };
      const fixedGoals = normalizeGoalValues(record.fixedGoals
        || (legacy.goal || legacy.macroGoals ? { kcal: legacy.goal, ...legacy.macroGoals } : undefined));
      nutrition[day] = {
        entries: record.entries
          .filter((entry) => entry && typeof entry.name === 'string' && isKnownNumber(entry.kcal))
          .map((entry) => ({
            ...entry,
            id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
            meal: PLANNER_MEALS.includes(entry.meal) ? entry.meal : 'other',
          })),
        isComplete: Boolean(record.isComplete),
        fixedGoals: fixedGoals && Object.keys(fixedGoals).length ? fixedGoals : undefined,
        waterMl: isKnownNumber(record.waterMl) ? record.waterMl : undefined,
      };
    });
  }

  // Этап 1: `calorieGoal` + `macroGoals`; spec 011: `goals` целиком
  const legacyGoals = saved as { calorieGoal?: PlannerGoal; macroGoals?: Partial<Record<PlannerMetric, PlannerGoal>> };
  const goals = normalizeGoalValues(saved.goals
    || (legacyGoals.calorieGoal || legacyGoals.macroGoals
      ? { kcal: legacyGoals.calorieGoal, ...legacyGoals.macroGoals } : undefined)) || empty.goals;
  const goalPeriods: PlannerGoalRecord[] = (Array.isArray(saved.goalPeriods) ? saved.goalPeriods : [])
    .filter((record) => record && typeof record.id === 'string' && record.id && record.goals)
    .map((record) => ({
      id: record.id,
      startDay: isDay(record.startDay) ? record.startDay : '',
      endDay: isDay(record.endDay) ? record.endDay : '',
      goals: normalizeGoalValues(record.goals) || {},
    }))
    .filter((record) => !validateGoalRecord(record));

  return {
    version: 1,
    tasks,
    events,
    projects,
    lists,
    nutrition,
    goals,
    goalPeriods,
    budget: isKnownNumber(saved.budget) && validateBudget(saved.budget) ? saved.budget : empty.budget,
    settings: normalizeSettings(saved.settings),
  };
}

// Правило повтора, экземпляры и происхождение из сохранённого объекта (негодное отбрасывается)
function normalizeSeries(raw: Partial<PlannerTask & PlannerEvent>) {
  const isDay = (value: unknown): value is string => typeof value === 'string' && DAY_KEY_PATTERN.test(value);
  const out: Pick<PlannerTask, 'repeat' | 'occurrences' | 'origin' | 'source'> = {};
  const r = raw.repeat;
  if (r && typeof r === 'object' && PLANNER_REPEAT_KINDS.includes(r.kind)) {
    const repeat: PlannerRepeat = {
      kind: r.kind,
      interval: isKnownNumber(r.interval) ? r.interval : 1,
      weekdays: Array.isArray(r.weekdays)
        ? r.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : undefined,
      monthDay: isKnownNumber(r.monthDay) && r.monthDay > 0 ? r.monthDay : undefined,
      startDay: isDay(r.startDay) ? r.startDay : '',
      endDay: isDay(r.endDay) ? r.endDay : undefined,
      count: isKnownNumber(r.count) && r.count > 0 ? r.count : undefined,
    };
    if (!validateRepeat(repeat)) out.repeat = repeat;
  }
  if (Array.isArray(raw.occurrences)) {
    const occurrences = raw.occurrences
      .filter((o) => o && isDay(o.day))
      .map((o): PlannerOccurrence => ({
        day: o.day,
        excluded: Boolean(o.excluded),
        done: Boolean(o.done),
        doneSteps: Array.isArray(o.doneSteps) ? o.doneSteps.filter((i) => Number.isInteger(i) && i >= 0) : [],
      }));
    if (occurrences.length) out.occurrences = occurrences;
  }
  if (raw.origin && typeof raw.origin.seriesId === 'string' && raw.origin.seriesId) {
    out.origin = { seriesId: raw.origin.seriesId, day: isDay(raw.origin.day) ? raw.origin.day : '' };
  }
  if (raw.source && typeof raw.source.opId === 'string' && raw.source.opId) {
    out.source = { chat: typeof raw.source.chat === 'string' ? raw.source.chat : '', opId: raw.source.opId };
  }
  return out;
}

function normalizeGoalValues(raw: unknown): PlannerGoalValues | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const values = raw as Partial<Record<PlannerGoalMetric, PlannerGoal | undefined>>;
  const out: PlannerGoalValues = {};
  PLANNER_GOAL_METRICS.forEach((metric) => {
    const goal = values[metric];
    if (goal && validateGoal(goal, metric === 'kcal' || metric === 'water')) {
      out[metric] = { target: goal.target, tolerance: goal.tolerance };
    }
  });
  return out;
}

// Настройки до T014 не сохранялись — отсутствие или негодные значения дают макетные
function normalizeSettings(raw: unknown): PlannerSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLANNER_SETTINGS };
  const saved = raw as Partial<PlannerSettings>;
  const settings: PlannerSettings = {
    dayStart: isKnownNumber(saved.dayStart) ? saved.dayStart : DEFAULT_PLANNER_SETTINGS.dayStart,
    dayEnd: isKnownNumber(saved.dayEnd) ? saved.dayEnd : DEFAULT_PLANNER_SETTINGS.dayEnd,
    lunchStart: isKnownNumber(saved.lunchStart) ? saved.lunchStart : DEFAULT_PLANNER_SETTINGS.lunchStart,
    lunchEnd: isKnownNumber(saved.lunchEnd) ? saved.lunchEnd : DEFAULT_PLANNER_SETTINGS.lunchEnd,
    margin: isKnownNumber(saved.margin) ? saved.margin : DEFAULT_PLANNER_SETTINGS.margin,
  };
  return validateSettings(settings) ? { ...DEFAULT_PLANNER_SETTINGS } : settings;
}
