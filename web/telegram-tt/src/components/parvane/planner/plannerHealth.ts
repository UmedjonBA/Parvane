// Здоровье в «Плане» (spec 020): применение черновика ввода текстом и сводки для экранов.
// Показатели вписывает пользователь; записи хранят только факт — источник автоматического сбора
// (мобильный клиент) сможет дописывать такие же записи с теми же идентификаторами дня.

import type {
  PlannerGoalMetric, PlannerHealthKind, PlannerHealthRecord, PlannerState,
} from './plannerModel';
import type { QuickDraft } from './plannerQuick';

import {
  addDays, ALL_DAY_END, ALL_DAY_START, ensureList, fromDayKey, isKnownNumber, makeFoodEntry, newId, toMinutes,
} from './plannerModel';
import { quickDescription } from './plannerQuick';

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
        description: quickDescription(draft),
        start: draft.isAllDay ? ALL_DAY_START : draft.start!,
        end: draft.isAllDay ? ALL_DAY_END : draft.end!,
        day: repeat ? undefined : draft.day,
        repeat,
        isAllDay: draft.isAllDay,
      });
      return draft.name;
    case 'task': {
      // Список из метки `#…`: существующий — по названию без учёта регистра, иначе новый — тем же путём,
      // что у полной формы
      const listName = draft.list?.trim().toLowerCase();
      const known = listName ? state.lists.find(({ name }) => name.toLowerCase() === listName) : undefined;
      const project = known?.name || ensureList(state, draft.list?.trim() || '')?.name || '';
      state.tasks.push({
        id: newId(),
        name: draft.name,
        description: quickDescription(draft) || '',
        steps: [],
        // Метка «!» — задача сразу «В работе»
        status: draft.isImportant ? 'active' : 'queue',
        project,
        minutes: draft.minutes,
        day: repeat ? undefined : draft.day,
        start: draft.start,
        due: draft.due,
        repeat,
        // Новая задача — первой в очереди
        rank: Math.min(0, ...state.tasks.map(({ rank }) => rank)) - 1,
      });
      return draft.name;
    }
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

// Индекс записей здоровья: запись вида на день (первая, как у `find`), записи вида по порядку данных и
// по дням — один проход по массиву. Массив опубликованного состояния не меняется (правки создают новый),
// в черновике он тоже заменяется целиком
type HealthIndex = {
  // Длина массива на момент построения: дописанный на месте массив перечитывается
  size: number;
  daily: Map<string, PlannerHealthRecord>;
  byKind: Map<string, PlannerHealthRecord[]>;
  // Записи вида по дню по возрастанию (устойчиво: тот же день — в порядке данных)
  sortedByKind: Map<string, PlannerHealthRecord[]>;
};

const healthIndexes = new WeakMap<PlannerHealthRecord[], HealthIndex>();

function getHealthIndex(state: PlannerState): HealthIndex {
  const { health } = state;
  let index = healthIndexes.get(health);
  if (index && index.size === health.length) return index;
  const daily = new Map<string, PlannerHealthRecord>();
  const byKind = new Map<string, PlannerHealthRecord[]>();
  health.forEach((record) => {
    const key = `${record.kind}|${record.day}`;
    if (!daily.has(key)) daily.set(key, record);
    const list = byKind.get(record.kind);
    if (list) list.push(record);
    else byKind.set(record.kind, [record]);
  });
  const sortedByKind = new Map<string, PlannerHealthRecord[]>();
  byKind.forEach((list, kind) => {
    sortedByKind.set(kind, [...list].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)));
  });
  index = {
    size: health.length, daily, byKind, sortedByKind,
  };
  healthIndexes.set(health, index);
  return index;
}

/** Запись показателя дня (одна на день). */
export function getDailyRecord(state: PlannerState, kind: PlannerHealthKind, day: string) {
  return getHealthIndex(state).daily.get(`${kind}|${day}`);
}

/** Последняя запись показателя не позже дня. */
export function getLatestRecord(state: PlannerState, kind: PlannerHealthKind, day: string) {
  const sorted = getHealthIndex(state).sortedByKind.get(kind);
  if (!sorted?.length) return undefined;
  // Двоичный поиск: первая запись позже дня
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle].day <= day) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return undefined;
  // Среди записей последнего дня — первая по порядку данных
  let at = low - 1;
  while (at > 0 && sorted[at - 1].day === sorted[at].day) at--;
  return sorted[at];
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
  const wanted = new Set(days);
  return (getHealthIndex(state).byKind.get('workout') || [])
    .filter((record) => wanted.has(record.day))
    .sort((a, b) => (a.day === b.day ? (b.time || '').localeCompare(a.time || '') : a.day < b.day ? 1 : -1));
}

/** Активные минуты тренировок: сумма их длительностей. */
export function sumActiveMinutes(workouts: PlannerHealthRecord[]) {
  return workouts.reduce((sum, record) => sum + record.value, 0);
}

/** Активные минуты за дни: длительность тренировок. */
export function getActiveMinutes(state: PlannerState, days: string[]) {
  return sumActiveMinutes(getWorkouts(state, days));
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

// ── режим сна ────────────────────────────────────────────────────────────────
// Регулярность сна: насколько время отхода ко сну и подъёма одинаково изо дня в день. Время суток —
// круг (23:40 и 00:20 в среднем дают 00:00, а не полдень), поэтому среднее и разброс считаются круговой
// статистикой: среднее — направление суммы единичных векторов, разброс — круговое стандартное
// отклонение sqrt(−2·ln R), где R — длина среднего вектора. При малом разбросе оно совпадает с обычным
// стандартным отклонением. Время — местное, «как на часах»: перевод часов не учитывается.
// Уровень — по худшему из двух разбросов (отход ко сну и подъём):
//   stable «стабильный» — не больше 30 мин. drifting «плавает» — не больше 60 мин. broken «сбит» — больше.
//   none «мало данных» — ночей, где записаны оба времени, меньше четырёх.
// Ночь с одной длительностью («спал 7,5 ч») в расчёт не идёт и считается отдельно — «без времени».
export const SLEEP_ROUTINE_DAYS = 14;
export const SLEEP_ROUTINE_MIN_NIGHTS = 4;
export const SLEEP_ROUTINE_STABLE_SPREAD = 30;
export const SLEEP_ROUTINE_DRIFTING_SPREAD = 60;
// Сколько самых выбившихся ночей называется поимённо
const SLEEP_ROUTINE_OUTLIERS = 3;
// Сдвиг выходных считается, когда и будних, и выходных ночей хотя бы столько
const SLEEP_JETLAG_MIN_NIGHTS = 2;
// «Обычное окно»: между этими долями ночей
const SLEEP_WINDOW_LOW = 0.1;
const SLEEP_WINDOW_HIGH = 0.9;
const MINUTES_IN_DAY = 1440;
const HALF_DAY = MINUTES_IN_DAY / 2;
const TURN = (2 * Math.PI) / MINUTES_IN_DAY;
// Средний вектор короче этого — времена разбросаны по всему кругу, среднего нет
const NO_DIRECTION = 1e-9;
const SATURDAY = 6;

export type SleepRoutineLevel = 'stable' | 'drifting' | 'broken' | 'none';

/** Время суток по ночам: среднее, разброс (мин) и «обычное окно» — времена минутами от полуночи. */
export type SleepClockStat = { mean: number; spread: number; from: number; to: number };

/** Ночь окна. Времена и отклонения от среднего (мин, «+» — позже) есть только у ночи с обоими временами. */
export type SleepNight = {
  day: string;
  minutes: number;
  bed?: number;
  wake?: number;
  midpoint?: number;
  bedDeviation?: number;
  wakeDeviation?: number;
  // Большее по модулю из двух отклонений
  deviation?: number;
};

export type SleepRoutine = {
  level: SleepRoutineLevel;
  days: string[];
  // Ночи с записью сна, от старой к новой
  nights: SleepNight[];
  timedCount: number;
  untimedCount: number;
  // Средняя середина сна по ночам со временем — центр оси графика, есть уже с первой такой ночи
  center?: number;
  // Дальше — только при достаточном числе ночей
  bed?: SleepClockStat;
  wake?: SleepClockStat;
  midpoint?: SleepClockStat;
  // Худший из разбросов отхода ко сну и подъёма
  spread?: number;
  // Самые выбившиеся ночи, от худшей
  outliers: SleepNight[];
  // Середина сна в выходные минус в будни, мин («+» — в выходные позже)
  socialJetlag?: number;
  // Среднее минус цель, мин («+» — позже цели)
  bedGoalDeviation?: number;
  wakeGoalDeviation?: number;
};

/** Время суток из любых минут: 1450 → 10, −20 → 1420. */
export function wrapClock(minutes: number) {
  return ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
}

/** Разница времён суток по кругу, −720…719 мин: 00:20 позже 23:40 на 40 мин. */
export function clockDifference(a: number, b: number) {
  return wrapClock(a - b + HALF_DAY) - HALF_DAY;
}

/** «23:40» → минуты от полуночи; негодная строка — `undefined`. */
export function parseClock(time?: string) {
  const match = time ? /^(\d{1,2}):(\d{2})$/.exec(time) : undefined;
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < MINUTES_IN_HOUR ? hours * MINUTES_IN_HOUR + minutes : undefined;
}

/** Цель режима (минуты от полуночи) из сохранённых целей: значение приходит из JSON, негодное — не цель. */
export function getClockGoal(value?: number) {
  return isKnownNumber(value) && value >= 0 && value < MINUTES_IN_DAY ? value : undefined;
}

function circularMean(values: number[]) {
  let x = 0;
  let y = 0;
  values.forEach((value) => {
    x += Math.cos(value * TURN);
    y += Math.sin(value * TURN);
  });
  const length = Math.min(1, Math.hypot(x, y) / values.length);
  return { length, mean: length < NO_DIRECTION ? values[0] : wrapClock(Math.atan2(y, x) / TURN) };
}

function quantile(sorted: number[], share: number) {
  const position = (sorted.length - 1) * share;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Круговые среднее и разброс времён суток (минуты от полуночи); пустой набор — `undefined`. */
export function getClockStat(values: number[]): SleepClockStat | undefined {
  if (!values.length) return undefined;
  const { length, mean } = circularMean(values);
  // У одинаковых времён длина вектора — единица: логарифм даёт «минус ноль», его и убирает max
  const spread = length < NO_DIRECTION
    ? HALF_DAY : Math.min(HALF_DAY, Math.sqrt(Math.max(0, -2 * Math.log(length))) / TURN);
  const deviations = values.map((value) => clockDifference(value, mean)).sort((a, b) => a - b);
  return {
    mean: wrapClock(Math.round(mean)),
    spread: Math.round(spread),
    from: wrapClock(Math.round(mean + quantile(deviations, SLEEP_WINDOW_LOW))),
    to: wrapClock(Math.round(mean + quantile(deviations, SLEEP_WINDOW_HIGH))),
  };
}

export function getSleepRoutineLevel(spread?: number): SleepRoutineLevel {
  if (spread === undefined) return 'none';
  if (spread <= SLEEP_ROUTINE_STABLE_SPREAD) return 'stable';
  return spread <= SLEEP_ROUTINE_DRIFTING_SPREAD ? 'drifting' : 'broken';
}

/** Режим сна по записям за `count` дней, заканчивающихся днём `day`. */
export function getSleepRoutine(state: PlannerState, day: string, count = SLEEP_ROUTINE_DAYS): SleepRoutine {
  const days = getLastDays(day, count);
  const nights: SleepNight[] = [];
  days.forEach((key) => {
    const record = getDailyRecord(state, 'sleep', key);
    if (!record) return;
    const bed = parseClock(record.time);
    const wake = parseClock(record.endTime);
    if (bed === undefined || wake === undefined || bed === wake) {
      nights.push({ day: key, minutes: record.value });
      return;
    }
    nights.push({
      day: key, minutes: record.value, bed, wake, midpoint: wrapClock(bed + wrapClock(wake - bed) / 2),
    });
  });
  const timed = nights.filter(({ bed }) => bed !== undefined);
  const midpoints = timed.map(({ midpoint }) => midpoint!);
  const routine: SleepRoutine = {
    level: 'none',
    days,
    nights,
    timedCount: timed.length,
    untimedCount: nights.length - timed.length,
    center: timed.length ? wrapClock(Math.round(circularMean(midpoints).mean)) : undefined,
    outliers: [],
  };
  if (timed.length < SLEEP_ROUTINE_MIN_NIGHTS) return routine;

  // Отклонения — от неокруглённого среднего: иначе у одинаковых ночей появляется лишняя минута
  const bedMean = circularMean(timed.map(({ bed }) => bed!)).mean;
  const wakeMean = circularMean(timed.map(({ wake }) => wake!)).mean;
  timed.forEach((night) => {
    night.bedDeviation = Math.round(clockDifference(night.bed!, bedMean));
    night.wakeDeviation = Math.round(clockDifference(night.wake!, wakeMean));
    night.deviation = Math.max(Math.abs(night.bedDeviation), Math.abs(night.wakeDeviation));
  });
  const bed = getClockStat(timed.map((night) => night.bed!))!;
  const wake = getClockStat(timed.map((night) => night.wake!))!;
  const spread = Math.max(bed.spread, wake.spread);
  // Ночь относится ко дню подъёма: выходные — ночи на субботу и на воскресенье
  const isFree = (night: SleepNight) => fromDayKey(night.day).getDay() % SATURDAY === 0;
  const free = timed.filter(isFree).map(({ midpoint }) => midpoint!);
  const work = timed.filter((night) => !isFree(night)).map(({ midpoint }) => midpoint!);
  const goalBed = getClockGoal(state.healthGoals.bedtime);
  const goalWake = getClockGoal(state.healthGoals.wakeTime);
  return {
    ...routine,
    level: getSleepRoutineLevel(spread),
    bed,
    wake,
    midpoint: getClockStat(midpoints),
    spread,
    outliers: timed
      .filter(({ deviation }) => deviation! > SLEEP_ROUTINE_STABLE_SPREAD)
      .sort((a, b) => b.deviation! - a.deviation! || (a.day < b.day ? 1 : -1))
      .slice(0, SLEEP_ROUTINE_OUTLIERS),
    socialJetlag: free.length >= SLEEP_JETLAG_MIN_NIGHTS && work.length >= SLEEP_JETLAG_MIN_NIGHTS
      ? Math.round(clockDifference(circularMean(free).mean, circularMean(work).mean)) : undefined,
    bedGoalDeviation: goalBed !== undefined ? Math.round(clockDifference(bedMean, goalBed)) : undefined,
    wakeGoalDeviation: goalWake !== undefined ? Math.round(clockDifference(wakeMean, goalWake)) : undefined,
  };
}
