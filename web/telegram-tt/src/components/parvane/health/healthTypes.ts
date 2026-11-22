// Parvane (spec 038): сводка «Здоровья» из движка (`healthView`, HEALTH-3) и разбор ввода (`healthParse`,
// HEALTH-2). Экран эти значения только показывает

export type HealthEntry = {
  id: string;
  kind: string;
  atMs: number;
  endMs: number;
  tzMin: number;
  day: string;
  value: number;
  value2: number;
  unit: string;
  source: string;
  note: string;
  // Еда: что съедено; тренировка: название
  name: string;
  // Приём пищи либо тип тренировки
  tag: string;
  // Именованные числа: БЖУ и граммы еды, километры и упражнения тренировки
  parts: Record<string, number>;
  // Когда запись внесена («записано в …»); 0 либо нет — неизвестно. Ставит хранилище, правки его не меняют
  createdMs?: number;
  // Только в записях подробного экрана (`healthEntries`): изменение к предыдущей записи вида, отклонение сна от
  // цели (минуты), пульс той же минуты у давления
  delta?: number;
  goalDelta?: number;
  pulse?: number;
};

// Итог дня вида-суммы (шаги, вода) с оценкой самочувствия дня
export type HealthDayTotal = {
  day: string;
  weekday: number;
  value: number;
  count: number;
  mood?: number;
  moodNote?: string;
};

export type HealthSleepPeriodStats = {
  nights: number;
  avgMinutes?: number;
  avgBedMin?: number;
  avgWakeMin?: number;
  bedDeltaMin?: number;
  wakeDeltaMin?: number;
  goalDeltaMin?: number;
};

// Режим сна за неделю по разбросу отбоя
export type HealthRegimeState = 'stable' | 'floating' | 'off' | 'few';

export type HealthSleepStats = {
  periods: Record<'week' | 'month' | 'year', HealthSleepPeriodStats>;
  regime: { state: HealthRegimeState; bedSpreadMin?: number; wakeSpreadMin?: number; isWakeStable: boolean };
  lastBedDeltaMin?: number;
};

export type HealthMetricPeriodStats = {
  avg?: number;
  avg2?: number;
  days: number;
  count: number;
  goalDays?: number;
  spanDays: number;
};

export type HealthMoodSleep = { lowSleepMin: number; lowDays: number; otherDays: number; delta?: number };

export type HealthSleepNight = {
  id: string;
  startMs: number;
  endMs: number;
  minutes: number;
  day: string;
  bedMin?: number;
  wakeMin?: number;
};

export type HealthSleepDay = {
  day: string;
  // 0 — понедельник
  weekday: number;
  minutes?: number;
  deltaMinutes?: number;
  bedMin?: number;
  wakeMin?: number;
};

export type HealthSleepView = {
  goalBedMin?: number;
  goalWakeMin?: number;
  goalMinutes?: number;
  last?: HealthSleepNight;
  lastTotalMinutes?: number;
  lastDeltaMinutes?: number;
  week: HealthSleepDay[];
  avgMinutes?: number;
  openStartMs?: number;
  // Сон по дням за 30 дней (сумма, «лёг / встал») и средняя ночь по месяцам года
  month: HealthSleepDay[];
  year: { month: string; minutes?: number }[];
  stats: HealthSleepStats;
};

export type HealthMetricView = {
  kind: string;
  unit: string;
  isSum: boolean;
  last?: HealthEntry;
  goal?: number;
  toGoal?: number;
  today?: number;
  weekDelta?: number;
  monthDelta?: number;
  yearDelta?: number;
  // Темп за неделю (вес)
  paceWeek?: number;
  // Цель — верхняя граница (давление)
  isUpperBound: boolean;
  periods: Record<'week' | 'month' | 'year', HealthMetricPeriodStats>;
  series: { day: string; weekday: number; value: number; value2: number; goalMet?: boolean }[];
  // Двенадцать месяцев: среднее значений дней; месяц без записей — без значения
  year: { month: string; value?: number; value2?: number }[];
};

export type HealthMacros = { kcal: number; protein: number; fat: number; carbs: number };

export type HealthMealView = HealthMacros & {
  meal: string;
  // Названия записей приёма через запятую
  names: string;
  entries: HealthEntry[];
};

export type HealthNutritionView = {
  day: string;
  closed: boolean;
  hasEntries: boolean;
  total: HealthMacros;
  goals: Partial<HealthMacros>;
  // Осталось до цели по калориям; отрицательное — перебор
  left?: number;
  meals: HealthMealView[];
  week: { day: string; weekday: number; kcal?: number; closed: boolean; full: boolean }[];
  weekAvg?: number;
};

export type HealthWorkoutView = HealthEntry & { minutes: number; weekday: number; paceSec?: number };

export type HealthActivityView = {
  stepsToday?: number;
  stepsGoal?: number;
  stepsWeek: { day: string; weekday: number; value?: number }[];
  activeMinutes: number;
  activeGoal?: number;
  workoutCount: number;
  km: number;
  workouts: HealthWorkoutView[];
};

export type HealthView = {
  today: string;
  sleep: HealthSleepView;
  metrics: HealthMetricView[];
  recent: HealthEntry[];
  moodSleep: HealthMoodSleep;
  nutrition: HealthNutritionView;
  activity: HealthActivityView;
};

// Запись без id: из формы, кнопки либо разбора — id даёт движок (`healthCompose`)
export type HealthDraft = Omit<HealthEntry, 'id' | 'day' | 'note' | 'name' | 'tag' | 'parts'> & {
  note?: string;
  name?: string;
  tag?: string;
  parts?: Record<string, number>;
};

export type HealthParsedEntry = {
  kind: string;
  atMs: number;
  endMs: number;
  tzMin: number;
  value: number;
  value2: number;
  unit: string;
  source: string;
  day: string;
  time: string;
  endDay?: string;
  endTime?: string;
  name?: string;
  tag?: string;
  parts?: Record<string, number>;
  // Догадка движка без единого числа: окно ввода «Плана» такую строку «Здоровью» не отдаёт
  guess?: boolean;
  /** Калории посчитаны из БЖУ, а не названы */
  computed?: boolean;
  // Еда по одному названию без слова приёма, числа — из прошлой записи: «План» такую строку оставляет себе
  bare?: boolean;
  // Калории, БЖУ и граммы подставлены движком из прошлой записи еды с тем же названием
  recalled?: boolean;
};

export type HealthParseResult = {
  entries: HealthParsedEntry[];
  unparsed: string[];
  problems: { text: string; code: string }[];
};

// Здоровье по дням для календаря «Плана» (`healthDays`): только дни с записями
export type HealthDay = {
  day: string;
  closed: boolean;
  sleeps: { id: string; minutes: number; bedMin?: number; wakeMin?: number }[];
  foods: { id: string; minute: number; name: string; tag: string; kcal: number; parts: Record<string, number> }[];
  workouts: {
    id: string; minute: number; minutes: number; name: string; tag: string; parts: Record<string, number>;
  }[];
};

export type HealthDays = { goals: Record<string, number>; days: HealthDay[] };

export type HealthStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';
