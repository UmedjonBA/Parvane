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
};

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
  // Сумма сна по дням за 30 дней и средняя ночь по месяцам года
  month: { day: string; minutes?: number }[];
  year: { month: string; minutes?: number }[];
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
  series: { day: string; value: number; value2: number }[];
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
};

export type HealthParseResult = {
  entries: HealthParsedEntry[];
  unparsed: string[];
  problems: { text: string; code: string }[];
};

export type HealthStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';
